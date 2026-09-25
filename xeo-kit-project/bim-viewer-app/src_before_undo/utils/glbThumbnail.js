import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export function generateGlbThumbnail(file, size = 256) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(size, size);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf1f5f9);

    scene.add(new THREE.AmbientLight(0xffffff, 1.2));
    const dirLight = new THREE.DirectionalLight(0xffffff, 2);
    dirLight.position.set(5, 10, 7);
    scene.add(dirLight);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);

    new GLTFLoader().load(
      url,
      (gltf) => {
        scene.add(gltf.scene);

        const box = new THREE.Box3().setFromObject(gltf.scene);
        const center = box.getCenter(new THREE.Vector3());
        const size3 = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size3.x, size3.y, size3.z);
        const dist = maxDim / (2 * Math.tan((Math.PI * 45) / 360));

        camera.position.set(
          center.x + dist * 0.8,
          center.y + dist * 0.6,
          center.z + dist * 0.8
        );
        camera.lookAt(center);
        camera.near = dist * 0.01;
        camera.far = dist * 10;
        camera.updateProjectionMatrix();

        renderer.render(scene, camera);

        renderer.domElement.toBlob((blob) => {
          URL.revokeObjectURL(url);
          renderer.dispose();
          resolve(blob);
        }, 'image/jpeg', 0.92);
      },
      undefined,
      (err) => {
        URL.revokeObjectURL(url);
        renderer.dispose();
        reject(err);
      }
    );
  });
}
