import firebase from 'firebase';
import { Promise, all } from 'rsvp';
import Adapter from 'ember-data/adapter';
import { computed } from '@ember/object';
import { assign } from '@ember/polyfills';
import { getOwner } from '@ember/application';
import { inject as service } from '@ember/service';
import RealtimeTracker from 'ember-cloud-firestore-adapter/utils/realtime-tracker';

import {
  updatePaginationMeta,
  paginateQuery,
  addPaginatedPayload,
} from 'ember-cloud-firestore-adapter/utils/pagination';

import {
  buildCollectionName,
  buildRefFromPath,
  flattenDocSnapshotData,
} from 'ember-cloud-firestore-adapter/utils/parser';

/**
 * @class CloudFirestore
 * @namespace Adapter
 * @extends DS.Adapter
 */
export default Adapter.extend({
  /**
   * @type {Ember.Service}
   */
  firebase: service(),

  /**
   * @type {Object}
   */
  firestoreSettings: null,

  /**
   * @type {string}
   */
  referenceKeyName: 'referenceTo',

  /**
   * @override
   */
  defaultSerializer: 'cloud-firestore',

  /**
   * @type {Ember.Service}
   */
  isFastBoot: computed({
    get() {
      const fastboot = getOwner(this).lookup('service:fastboot');

      return fastboot && fastboot.isFastBoot;
    },
  }),

  /**
   * @override
   */
  init(...args) {
    this._super(...args);

    if (this.firestoreSettings) {
      const db = this.firebase.firestore();

      db.settings(this.firestoreSettings);
    }

    this.set('realtimeTracker', new RealtimeTracker());
  },

  buildCollectionName(type) {
    return buildCollectionName(type);
  },

  /**
   * @override
   */
  generateIdForRecord(store, type, context) {
    const db = this.firebase.firestore();
    const collectionName = this.buildCollectionName(type, context);

    return db.collection(collectionName).doc().id;
  },

  /**
   * @override
   */
  async createRecord(...args) {
    return this.updateRecord(...args);
  },

  /**
   * @override
   */
  async updateRecord(store, type, snapshot) {
    const docRef = this.buildCollectionRef(type, snapshot.adapterOptions).doc(snapshot.id);
    const batch = this.buildWriteBatch(docRef, snapshot);

    const batches = {
      queue: [],

      commit() {
        const { queue } = this;
        if (!queue.length) return null;
        if (queue.length === 1) return queue[0].commit();
        return all(queue.map(b => b.commit()));
      },

      push(b) {
        this.queue.push(b);
      },
    };

    if (batch._mutations && batch._mutations.length >= 500) {
      const db = this.firebase.firestore();
      while (batch._mutations.length > 0) {
        const splitBatch = db.batch();
        const mutations = batch._mutations.splice(0, 500);
        splitBatch._mutations = mutations;
        batches.push(splitBatch);
      }
    } else {
      batches.push(batch);
    }

    await batches.commit();

    if (this.getAdapterOptionConfig(snapshot, 'isRealtime') && !this.isFastBoot) {
      return this.findRecord(store, type, snapshot.id, snapshot);
    }

    const data = this.serialize(snapshot, { includeId: true });

    Object.keys(data).forEach((key) => {
      if (data[key] === firebase.firestore.FieldValue.serverTimestamp()) {
        data[key] = new Date();
      }
    });

    return data;
  },

  /**
   * @override
   */
  async deleteRecord(store, type, snapshot) {
    const db = this.firebase.firestore();
    const docRef = this.buildCollectionRef(type, snapshot.adapterOptions).doc(snapshot.id);
    const batch = db.batch();

    batch.delete(docRef);
    this.addIncludeToWriteBatch(batch, snapshot);

    return batch.commit();
  },

  /**
   * @override
   */
  async findRecord(store, type, id, snapshot = {}) {
    return new Promise((resolve, reject) => {
      const db = this.firebase.firestore();

      let docRef = (snapshot._internalModel &&
                  snapshot._internalModel.getAttributeValue('docRef')) ||
                  (snapshot.adapterOptions &&
                  snapshot.adapterOptions.docRef) ||
                  (snapshot.adapterOptions &&
                  snapshot.adapterOptions.buildReference &&
                  this.buildCollectionRef(type, snapshot.adapterOptions, db).doc(id));

      if (!docRef) {
        const collectionName = this.buildCollectionName(type.modelName, snapshot);
        docRef = db.collection(collectionName).doc(id);
      }

      const unsubscribe = docRef.onSnapshot((docSnapshot) => {
        if (docSnapshot.exists) {
          if (this.getAdapterOptionConfig(snapshot, 'isRealtime') && !this.isFastBoot) {
            this.realtimeTracker.trackFindRecordChanges(type.modelName, docRef, store);
          }

          resolve(flattenDocSnapshotData(docSnapshot));
        } else if (docSnapshot.metadata && docSnapshot.metadata.fromCache) {
          reject(new Error('Connection to Firestore unavailable'));
        } else {
          reject(new Error(`Document doesn't exist: Record ${id} for model type ${type.modelName}`));
        }

        unsubscribe();
      }, error => reject(new Error(error.message)));
    });
  },

  /**
   * @override
   */
  async findAll(store, type, sinceToken, snapshotRecordArray) {
    return new Promise((resolve, reject) => {
      const db = this.firebase.firestore();
      const collectionName = this.buildCollectionName(type.modelName);
      const collectionRef = db.collection(collectionName);
      const unsubscribe = collectionRef.onSnapshot((querySnapshot) => {
        if (this.getAdapterOptionConfig(snapshotRecordArray, 'isRealtime') && !this.isFastBoot) {
          this.realtimeTracker.trackFindAllChanges(type.modelName, collectionRef, store);
        }

        const requests = querySnapshot.docs.map(docSnapshot => (
          this.findRecord(store, type, docSnapshot.id, snapshotRecordArray)
        ));

        Promise.all(requests).then(records => resolve(records)).catch(error => (
          reject(new Error(error.message))
        ));

        unsubscribe();
      }, error => reject(new Error(error.message)));
    });
  },

  /**
   * @override
   */
  async findBelongsTo(store, snapshot, url, relationship) {
    const type = { modelName: relationship.type };
    const urlNodes = url.split('/');
    const id = urlNodes.pop();

    return this.findRecord(store, type, id, {
      adapterOptions: {
        isRealtime: relationship.options.isRealtime,

        buildReference(db) {
          return buildRefFromPath(db, urlNodes.join('/'));
        },
      },
    });
  },

  /**
   * @override
   */
  async findHasMany(store, snapshot, url, relationship) {
    return new Promise((resolve, reject) => {
      const collectionRef = this.buildHasManyCollectionRef(store, snapshot, url, relationship);

      const unsubscribe = collectionRef.onSnapshot((querySnapshot) => {
        if (relationship.options.isRealtime && !this.isFastBoot) {
          this.realtimeTracker.trackFindHasManyChanges(
            snapshot.modelName,
            snapshot.id,
            relationship,
            collectionRef,
            store,
          );
        }

        const requests = this.findHasManyRecords(store, relationship, querySnapshot);

        Promise.all(requests).then((records) => {
          records.map(payload => this._injectCollectionRef(payload, url));
          updatePaginationMeta(relationship, records);
          addPaginatedPayload(snapshot, relationship, records);
          resolve(records);
        }).catch(error => (
          reject(new Error(error.message))
        ));

        unsubscribe();
      }, error => reject(new Error(error.message)));
    });
  },

  /**
   * @override
   */
  async query(store, type, query, recordArray) {
    return new Promise((resolve, reject) => {
      const collectionRef = this.buildCollectionRef(type, query);
      const firestoreQuery = this.buildQuery(collectionRef, query);
      const unsubscribe = firestoreQuery.onSnapshot((querySnapshot) => {
        if (
          this.getAdapterOptionConfig({ adapterOptions: query }, 'isRealtime')
          && !this.isFastBoot
        ) {
          this.realtimeTracker.trackQueryChanges(firestoreQuery, recordArray, query.queryId);
        }

        const requests = this.findQueryRecords(store, type, query, querySnapshot);

        Promise.all(requests).then(records => resolve(records)).catch(error => (
          reject(new Error(error.message))
        ));

        unsubscribe();
      }, error => reject(new Error(error.message)));
    });
  },

  /**
   * @param {DS.Model} type
   * @param {Object} [adapterOptions={}]
   * @return {firebase.firestore.CollectionReference} Collection reference
   * @function
   * @private
   */
  buildCollectionRef(type, adapterOptions = {}) {
    const db = this.firebase.firestore();

    if (Object.prototype.hasOwnProperty.call(adapterOptions, 'buildReference')) {
      return adapterOptions.buildReference(db);
    } else if (adapterOptions.collectionPath) {
      return db.collection(adapterOptions.collectionPath);
    }

    return db.collection(buildCollectionName(type.modelName));
  },

  /**
   * @param {firebase.firestore.WriteBatch} batch
   * @param {firebase.firestore.DocumentReference} docRef
   * @param {DS.Snapshot} snapshot
   * @function
   * @private
   */
  addDocRefToWriteBatch(batch, docRef, snapshot) {
    const data = this.serialize(snapshot);

    batch.set(docRef, data, { merge: true });
  },

  /**
   * @param {firebase.firestore.WriteBatch} batch
   * @param {Object} snapshot
   * @function
   * @private
   */
  addIncludeToWriteBatch(batch, snapshot) {
    const db = this.firebase.firestore();
    const meta = this.getAdapterOptionConfig(snapshot, 'meta');
    const include = this.getAdapterOptionConfig(snapshot, 'include');

    if (include) {
      include(batch, db, meta);
    }
  },

  /**
   * @param {firebase.firestore.DocumentReference} docRef
   * @param {DS.Snapshot} snapshot
   * @return {firebase.firestore.WriteBatch} Batch instance
   * @function
   * @private
   */
  buildWriteBatch(docRef, snapshot) {
    const db = this.firebase.firestore();
    const batch = db.batch();

    this.addDocRefToWriteBatch(batch, docRef, snapshot);
    this.addIncludeToWriteBatch(batch, snapshot);

    return batch;
  },

  /**
   * @param {firebase.firestore.CollectionReference} collectionRef
   * @param {Object} [option={}]
   * @param {Object} [snapshot]
   * @return {firebase.firestore.Query} Query
   * @function
   * @private
   */
  buildQuery(collectionRef, option = {}, snapshot = {}) {
    const { record, adapterOptions = {} } = snapshot;
    let newRef = collectionRef;

    if (Object.prototype.hasOwnProperty.call(option, 'filter')) {
      newRef = option.filter(newRef, record);
    }

    if (Object.prototype.hasOwnProperty.call(option, 'pagination')) {
      newRef = paginateQuery(newRef, option.pagination, adapterOptions);
    } else if (Object.prototype.hasOwnProperty.call(option, 'limit')) {
      newRef = newRef.limit(option.limit);
    }

    return newRef;
  },

  /**
   * @param {DS.Store} store
   * @param {DS.Snapshot} snapshot
   * @param {string} url
   * @param {Object} relationship
   * @return {firebase.firestore.CollectionReference|firebase.firestore.Query} Reference
   * @function
   * @private
   */
  buildHasManyCollectionRef(store, snapshot, url, relationship) {
    const db = this.firebase.firestore();
    const cardinality = snapshot.type.determineRelationshipType(relationship, store);
    let collectionRef;

    if (cardinality === 'manyToOne') {
      const path = this.buildCollectionName(relationship.type, snapshot, relationship.meta);
      const inverseRelationship = snapshot.type.inverseFor(relationship.key, store);

      const referencePath = this.buildCollectionName(
        snapshot.modelName,
        snapshot,
        inverseRelationship,
      );

      const reference = db.collection(referencePath).doc(snapshot.id);
      const { filterByInverse } = relationship.options;

      if (!inverseRelationship || !filterByInverse) {
        collectionRef = buildRefFromPath(db, path);
      } else {
        collectionRef = db.collection(path).where(inverseRelationship.name, '==', reference);
      }
    } else if (Object.prototype.hasOwnProperty.call(relationship.options, 'buildReference')) {
      collectionRef = relationship.options.buildReference(db, snapshot.record);
    } else {
      const path = this.buildCollectionName(relationship.type, snapshot, relationship.meta);
      collectionRef = buildRefFromPath(db, path);
    }

    return this.buildQuery(collectionRef, relationship.options, snapshot);
  },

  /**
   * @param {DS.Store} store
   * @param {Object} relationship
   * @param {firebase.firestore.QuerySnapshot} querySnapshot
   * @return {Array} Has many record requests
   * @function
   * @private
   */
  findHasManyRecords(store, relationship, querySnapshot) {
    return querySnapshot.docs.map((docSnapshot) => {
      const type = { modelName: relationship.type };
      const referenceTo = docSnapshot.get(this.referenceKeyName) || docSnapshot.ref;

      if (referenceTo && referenceTo.firestore) {
        return this.findRecord(store, type, referenceTo.id, {
          adapterOptions: {
            isRealtime: relationship.options.isRealtime,

            buildReference() {
              return referenceTo.parent;
            },
          },
        });
      }

      const adapterOptions = assign({}, relationship.options, {
        buildReference() {
          return docSnapshot.ref.parent;
        },
      });

      return this.findRecord(store, type, docSnapshot.id, { adapterOptions });
    });
  },

  /**
   * @param {DS.Store} store
   * @param {DS.Model} type
   * @param {Object} option
   * @param {firebase.firestore.QuerySnapshot} querySnapshot
   * @return {Array.<Promise>} Find record promises
   * @function
   * @private
   */
  findQueryRecords(store, type, option, querySnapshot) {
    return querySnapshot.docs.map((docSnapshot) => {
      const referenceTo = docSnapshot.get(this.referenceKeyName) || docSnapshot.ref;

      if (referenceTo && referenceTo.firestore) {
        const request = this.findRecord(store, type, referenceTo.id, {
          adapterOptions: {
            isRealtime: option.isRealtime,

            buildReference() {
              return referenceTo.parent;
            },
          },
        });

        return request;
      }

      const adapterOptions = assign({}, option, {
        buildReference() {
          return docSnapshot.ref.parent;
        },
      });

      return this.findRecord(store, type, docSnapshot.id, { adapterOptions });
    });
  },

  /**
   * @param {DS.Snapshot} snapshot
   * @param {string} prop
   * @return {*} Value of adapter option config
   * @function
   * @private
   */
  getAdapterOptionConfig(snapshot, prop) {
    try {
      return snapshot.adapterOptions[prop];
    } catch (error) {
      return null;
    }
  },
});
