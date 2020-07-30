import { inject } from '@ember/service';
import { typeOf } from '@ember/utils';
import JSONSerializer from 'ember-data/serializers/json';

import {
  buildCollectionName,
  buildPathFromRef,
  buildRefFromPath,
} from 'ember-cloud-firestore-adapter/utils/parser';

/**
 * @param {*} value
 * @return {boolean} True if is a document reference. Otherwise, false.
 */
function isDocumentReference(value) {
  return typeOf(value) === 'object' && value.firestore;
}

/**
 * @class CloudFirestore
 * @namespace Serializer
 * @extends DS.JSONSerializer
 */
export default JSONSerializer.extend({
  /**
   * @type {Ember.Service}
   */
  firebase: inject(),

  buildCollectionName(modelName) {
    return buildCollectionName(modelName);
  },

  // getNamespace(snapshot) {
  //   return null;
  // },

  /**
   * Overriden to convert a DocumentReference into an JSON API relationship object
   *
   * @override
   */
  extractRelationship(relationshipModelName, relationshipHash) {
    if (isDocumentReference(relationshipHash)) {
      const path = buildPathFromRef(relationshipHash);
      const pathNodes = path.split('/');
      const belongsToId = pathNodes[pathNodes.length - 1];

      return {
        id: belongsToId,
        type: relationshipModelName,
        data: { docRef: relationshipHash },
      };
    }

    return this._super(relationshipModelName, relationshipHash);
  },

  /**
   * Extended to add links for all relationship
   *
   * @override
   */
  extractRelationships(modelClass, resourceHash) {
    const links = {};

    modelClass.eachRelationship((name, descriptor) => {
      if (descriptor.kind === 'belongsTo') {
        const key = this.keyForRelationship(name, 'belongsTo', 'serialize');

        if (
          Object.prototype.hasOwnProperty.call(resourceHash, name)
          && isDocumentReference(resourceHash[name])
        ) {
          const path = buildPathFromRef(resourceHash[key]);

          links[name] = path;
        }
      } else {
        const cardinality = modelClass.determineRelationshipType(descriptor, this.store);
        let hasManyPath;

        if (descriptor.meta.options.isReference) {
          return;
        } else if (cardinality === 'manyToOne') {
          resourceHash.modelName = modelClass.modelName;
          const collectionName = this.buildCollectionName(
            modelClass.modelName,
            resourceHash,
            descriptor.meta,
          );
          hasManyPath = collectionName;
        } else {
          const collectionName = this.buildCollectionName(modelClass.modelName);
          const docId = resourceHash.id;
          hasManyPath = [collectionName, docId, name].compact().join('/');
        }

        links[name] = hasManyPath;
      }
    });

    resourceHash.links = links;

    return this._super(modelClass, resourceHash);
  },

  /**
   * Overriden to convert a belongs-to relationship to a DocumentReference
   *
   * @override
   */
  serializeBelongsTo(snapshot, json, relationship) {
    this._super(snapshot, json, relationship);

    const { key } = relationship;

    if (json[key]) {
      const collectionName = this.buildCollectionName(
        relationship.type,
        snapshot,
        relationship.meta,
      );

      const docId = json[key];
      const path = `${collectionName}/${docId}`;

      json[key] = buildRefFromPath(this.firebase.firestore(), path);
    }
  },

  /**
   * @override
   */
  serializeHasMany(snapshot, json, relationship) {
    this._super(snapshot, json, relationship);

    const { key } = relationship;

    if (json[key]) {
      const references = [];

      json[key].forEach((docId) => {
        const collectionName = this.buildCollectionName(
          relationship.type,
          snapshot,
          relationship.meta,
        );

        const path = `${collectionName}/${docId}`;

        references.push(buildRefFromPath(this.get('firebase').firestore(), path));
      });

      delete json[key];

      json[key] = references;
    }
  },

  /**
   * @override
   */
  serialize(snapshot, ...args) {
    const json = this._super(snapshot, ...args);

    snapshot.eachRelationship((name, relationship) => {
      // We want to save hasMany references as well with the model
      if (relationship.kind === 'hasMany' && !relationship.options.isReference) {
        delete json[name];
      }
    });

    return json;
  },
});
