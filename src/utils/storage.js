import { omitBy, isUndefined } from 'lodash'
import { actionTypes } from '../constants'

const { FILE_UPLOAD_ERROR, FILE_UPLOAD_PROGRESS } = actionTypes

/**
 * Delete file from Firebase Storage with support for deleteing meta
 * data from database (either Real Time Database or Firestore depending on
 * config)
 * @param {object} firebase - Internal firebase object
 * @param {object} settings - Settings object
 * @param {string} settings.path - Path to File which should be deleted
 * @param {string} settings.dbPath - Path of meta data with Database (Real Time Or
 * Firestore depnding on config)
 * @returns {Promise} Resolves with path and dbPath
 */
export function deleteFile(firebase, { path, dbPath }) {
  return firebase
    .storage()
    .ref(path)
    .delete()
    .then(() => {
      // return path if dbPath or a database does not exist
      if (!dbPath || (!firebase.database && !firebase.firestore)) {
        return { path }
      }

      // Choose delete function based on config (Handling Firestore and RTDB)
      const metaDeletePromise = () =>
        firebase._.config.useFirestoreForStorageMeta
          ? firebase
              .firestore()
              .doc(dbPath)
              .delete() // file meta in Firestore
          : firebase
              .database()
              .ref(dbPath)
              .remove() // file meta in RTDB

      return metaDeletePromise().then(() => ({ path, dbPath }))
    })
}

/**
 * Create a function to handle response from upload.
 * @param {object} settings - Settings object
 * @param {object} settings.fileData - File data which was uploaded
 * @param {object} settings.uploadTaskSnapshot - Snapshot from storage upload task
 * @returns {Function} Function for handling upload result
 */
function createUploadMetaResponseHandler({
  fileData,
  firebase,
  uploadTaskSnapshot,
  downloadURL
}) {
  /**
   * Converts upload meta data snapshot into an object (handling both
   * RTDB and Firestore)
   * @param  {object} metaDataSnapshot - Snapshot from metadata upload (from
   * RTDB or Firestore)
   * @returns {object} Upload result including snapshot, key, File
   */
  return function uploadResultFromSnap(metaDataSnapshot) {
    const { useFirestoreForStorageMeta } = firebase._.config
    const result = {
      snapshot: metaDataSnapshot,
      key: metaDataSnapshot.key || metaDataSnapshot.id,
      File: fileData,
      metaDataSnapshot,
      uploadTaskSnapshot,
      // Support legacy method
      uploadTaskSnaphot: uploadTaskSnapshot,
      createdAt: useFirestoreForStorageMeta
        ? firebase.firestore.FieldValue.serverTimestamp()
        : firebase.database.ServerValue.TIMESTAMP
    }
    // Attach id if it exists (Firestore)
    if (metaDataSnapshot.id) {
      result.id = metaDataSnapshot.id
    }
    // Attach downloadURL if it exists
    if (downloadURL) {
      result.downloadURL = downloadURL
    }
    return result
  }
}

/**
 * Get download URL from upload task snapshot
 * @param {firebase.storage.UploadTaskSnapshot} uploadTaskSnapshot - Upload task snapshot
 * @returns {Promise} Resolves with download URL
 */
function getDownloadURLFromUploadTaskSnapshot(uploadTaskSnapshot) {
  // Handle different downloadURL patterns (Firebase JS SDK v5.*.* vs v4.*.*)
  if (
    uploadTaskSnapshot.ref &&
    typeof uploadTaskSnapshot.ref.getDownloadURL === 'function'
  ) {
    // Get downloadURL and attach to response
    return uploadTaskSnapshot.ref.getDownloadURL()
  }
  // Only attach downloadURL if downloadURLs is defined (not defined in v5.*.*)
  return Promise.resolve(
    uploadTaskSnapshot.downloadURLs && uploadTaskSnapshot.downloadURLs[0]
  )
}

/**
 * Write file metadata to Database (either Real Time Datbase or Firestore
 * depending on config).
 * @param {object} settings - Settings object
 * @param {object} settings.firebase - Internal firebase object
 * @param {object} settings.uploadTaskSnapshot - Snapshot from upload task
 * @param {string} settings.dbPath - Path of meta data with Database (Real Time Or
 * Firestore depnding on config)
 * @returns {Promise} Resolves with payload (includes snapshot, File, and
 * metaDataSnapshot)
 */
export function writeMetadataToDb({
  firebase,
  uploadTaskSnapshot,
  dbPath,
  options
}) {
  // Support metadata factories from both global config and options
  const { fileMetadataFactory, useFirestoreForStorageMeta } = firebase._.config
  const { metadataFactory } = options
  const metaFactoryFunction = metadataFactory || fileMetadataFactory
  // Get download URL for use in metadata write
  return getDownloadURLFromUploadTaskSnapshot(uploadTaskSnapshot).then(
    downloadURL => {
      // Apply fileMetadataFactory if it exists in config
      const fileData =
        typeof metaFactoryFunction === 'function'
          ? metaFactoryFunction(
              uploadTaskSnapshot,
              firebase,
              uploadTaskSnapshot.metadata,
              downloadURL
            )
          : omitBy(uploadTaskSnapshot.metadata, isUndefined)

      // Create the snapshot handler function
      const resultFromSnap = createUploadMetaResponseHandler({
        fileData,
        firebase,
        uploadTaskSnapshot,
        downloadURL
      })

      // Function for creating promise for writing file metadata (handles writing to RTDB or Firestore)
      const metaSetPromise = fileData => {
        if (useFirestoreForStorageMeta) {
          return firebase // Write metadata to Firestore
            .firestore()
            .collection(dbPath)
            .add(fileData)
        }
        // Create new reference for metadata
        const newMetaRef = firebase
          .database()
          .ref(dbPath)
          .push()
        // Write metadata to Real Time Database and return new meta ref
        return newMetaRef.set(fileData).then(res => newMetaRef)
      }

      return metaSetPromise(fileData).then(resultFromSnap)
    }
  )
}

/**
 * Upload a file with actions fired for progress, success, and errors
 * @param {Function} dispatch - Action dispatch function
 * @param {object} firebase - Internal firebase object
 * @param {object} opts - File data object
 * @param {object} opts.path - Location within Firebase Stroage at which to upload file.
 * @param {Blob|string} opts.file - File to upload
 * @param {object} opts.fileMetadata - Metadata to pass along to storageRef.put call
 * @returns {Promise} Promise which resolves after file upload
 * @private
 */
export function uploadFileWithProgress(
  dispatch,
  firebase,
  { path, file, filename, meta, fileMetadata }
) {
  const ref = firebase.storage().ref(`${path}/${filename}`)
  let uploadEvent

  if (typeof file === 'string') {
    if (
      firebase.storage.Native &&
      file.startsWith(firebase.storage.Native.DOCUMENT_DIRECTORY_PATH)
    ) {
      // file is react-native uri`
      uploadEvent = ref.putFile(file, fileMetadata)
    }
  } else {
    uploadEvent = ref.put(file, fileMetadata)
  }

  const unListen = uploadEvent.on(firebase.storage.TaskEvent.STATE_CHANGED, {
    next: snapshot => {
      dispatch({
        type: FILE_UPLOAD_PROGRESS,
        meta,
        payload: {
          snapshot,
          percent: Math.floor(
            snapshot.bytesTransferred / snapshot.totalBytes * 100
          )
        }
      })
    },
    error: err => {
      dispatch({ type: FILE_UPLOAD_ERROR, meta, payload: err })
      unListen()
    },
    complete: () => {
      unListen()
    }
  })
  return uploadEvent
}
