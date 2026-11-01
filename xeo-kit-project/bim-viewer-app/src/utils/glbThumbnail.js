import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/**
 * Generate a small catalogue-only preview without changing the uploaded GLB.
 * A neutral studio environment gives metallic/PBR materials something to reflect,
 * which is especially important for assets that look very dark under direct light
 * alone. The generated JPEG is only a thumbnail; the original model is uploaded.
 */
export function generateGlbThumbnail(file, size = 256) {
  return new Promise((resolve, reject) => {
    let url = null;
    let renderer = null;
    let pmremGenerator = null;
    let environment = null;
    let roomEnvironment = null;
    let cleaned = false;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (url) URL.revokeObjectURL(url);
      try { environment?.dispose(); } catch (_) {}
      try { roomEnvironment?.dispose(); } catch (_) {}
      try { pmremGenerator?.dispose(); } catch (_) {}
      try { renderer?.dispose(); } catch (_) {}
    };

    try {
      url = URL.createObjectURL(file);
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
      renderer.setPixelRatio(1);
      renderer.setSize(size, size, false);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.0;

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0xf1f5f9);

      // PBR metallic materials need an environment to reflect. This environment
      // exists only while rendering the admin thumbnail and is promptly disposed.
      pmremGenerator = new THREE.PMREMGenerator(renderer);
      roomEnvironment = new RoomEnvironment();
      environment = pmremGenerator.fromScene(roomEnvironment, 0.04);
      scene.environment = environment.texture;

      const hemiLight = new THREE.HemisphereLight(0xffffff, 0xcbd5e1, 1.1);
      scene.add(hemiLight);
      const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
      keyLight.position.set(5, 8, 6);
      scene.add(keyLight);
      const fillLight = new THREE.DirectionalLight(0xdbeafe, 0.7);
      fillLight.position.set(-5, 3, -4);
      scene.add(fillLight);

      const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 10000);
      new GLTFLoader().load(
        url,
        (gltf) => {
          try {
            scene.add(gltf.scene);
            gltf.scene.updateWorldMatrix(true, true);

            const box = new THREE.Box3().setFromObject(gltf.scene);
            if (box.isEmpty()) throw new Error('GLB contains no renderable geometry.');
            const center = box.getCenter(new THREE.Vector3());
            const sphere = box.getBoundingSphere(new THREE.Sphere());
            const radius = Math.max(sphere.radius, 0.05);
            const distance = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.2;
            const direction = new THREE.Vector3(1.25, 0.8, 1.3).normalize();
            camera.position.copy(center).addScaledVector(direction, distance);
            camera.near = Math.max(distance / 1000, 0.001);
            camera.far = Math.max(distance * 100, 100);
            camera.lookAt(center);
            camera.updateProjectionMatrix();

            renderer.render(scene, camera);
            renderer.domElement.toBlob((blob) => {
              cleanup();
              if (!blob) {
                reject(new Error('Could not encode GLB catalogue thumbnail.'));
                return;
              }
              resolve(blob);
            }, 'image/jpeg', 0.92);
          } catch (error) {
            cleanup();
            reject(error);
          }
        },
        undefined,
        (error) => {
          cleanup();
          reject(error);
        }
      );
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
