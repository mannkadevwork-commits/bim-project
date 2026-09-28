import * as THREE from 'three';
import * as WebIFC from 'web-ifc';

export function generateIfcThumbnail(file, size = 256) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = new Uint8Array(e.target.result);

        const ifcAPI = new WebIFC.IfcAPI();
        ifcAPI.SetWasmPath('/');
        await ifcAPI.Init();

        const modelID = ifcAPI.OpenModel(data);

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        renderer.setSize(size, size);
        renderer.outputColorSpace = THREE.SRGBColorSpace;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0xf1f5f9);
        scene.add(new THREE.AmbientLight(0xffffff, 1.2));
        const dir = new THREE.DirectionalLight(0xffffff, 2);
        dir.position.set(5, 10, 7);
        scene.add(dir);

        const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);

        // Pull all geometry from the IFC model
        const geometries = ifcAPI.LoadAllGeometry(modelID);
        const group = new THREE.Group();

        for (let i = 0; i < geometries.size(); i++) {
          const placedGeom = geometries.get(i);
          for (let j = 0; j < placedGeom.geometries.size(); j++) {
            const geomData = placedGeom.geometries.get(j);
            const ifcGeom = ifcAPI.GetGeometry(modelID, geomData.geometryExpressID);
            const vertexData = ifcAPI.GetVertexArray(ifcGeom.GetVertexData(), ifcGeom.GetVertexDataSize());
            const indexData = ifcAPI.GetIndexArray(ifcGeom.GetIndexData(), ifcGeom.GetIndexDataSize());

            const geo = new THREE.BufferGeometry();
            // vertexData is interleaved: x,y,z,nx,ny,nz per vertex
            const positions = new Float32Array(vertexData.length / 2);
            const normals = new Float32Array(vertexData.length / 2);
            for (let k = 0; k < vertexData.length; k += 6) {
              const base = (k / 6) * 3;
              positions[base]     = vertexData[k];
              positions[base + 1] = vertexData[k + 1];
              positions[base + 2] = vertexData[k + 2];
              normals[base]       = vertexData[k + 3];
              normals[base + 1]   = vertexData[k + 4];
              normals[base + 2]   = vertexData[k + 5];
            }
            geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
            geo.setIndex(new THREE.BufferAttribute(indexData, 1));

            const c = geomData.color;
            const mat = new THREE.MeshLambertMaterial({
              color: new THREE.Color(c.x, c.y, c.z),
              transparent: c.w < 1,
              opacity: c.w,
              side: THREE.DoubleSide,
            });

            const m = new THREE.Matrix4().fromArray(geomData.flatTransformation);
            const mesh = new THREE.Mesh(geo, mat);
            mesh.applyMatrix4(m);
            group.add(mesh);

            ifcGeom.delete();
          }
        }

        ifcAPI.CloseModel(modelID);
        scene.add(group);

        const box = new THREE.Box3().setFromObject(group);
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
          renderer.dispose();
          resolve(blob);
        }, 'image/jpeg', 0.92);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}
