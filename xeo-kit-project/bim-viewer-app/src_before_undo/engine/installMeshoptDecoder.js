import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'

const PATCH_FLAG = Symbol.for('hci.meshoptLoaderPatched')

if (!GLTFLoader.prototype[PATCH_FLAG]) {
  const originalLoad = GLTFLoader.prototype.load
  const originalLoadAsync = GLTFLoader.prototype.loadAsync

  GLTFLoader.prototype.load = function loadWithMeshopt(
    url,
    onLoad,
    onProgress,
    onError,
  ) {
    this.setMeshoptDecoder(MeshoptDecoder)
    return originalLoad.call(this, url, onLoad, onProgress, onError)
  }

  if (typeof originalLoadAsync === 'function') {
    GLTFLoader.prototype.loadAsync = function loadAsyncWithMeshopt(
      url,
      onProgress,
    ) {
      this.setMeshoptDecoder(MeshoptDecoder)
      return originalLoadAsync.call(this, url, onProgress)
    }
  }

  Object.defineProperty(GLTFLoader.prototype, PATCH_FLAG, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  })
}
