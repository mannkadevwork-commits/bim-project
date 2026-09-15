import * as THREE from "three";

/**
 * Walkthrough-only runtime performance guard.
 *
 * Why this exists:
 * - The current production GLB contains ~14k nodes and ~7k mesh nodes.
 * - The walkthrough was forcing frustumCulled=false for every mesh.
 * - Three.js then has to traverse/test/render much more of the scene than
 *   necessary on every frame.
 *
 * This module is imported before the React app mounts. It does not modify
 * the compiler, xeokit editor, or other non-walkthrough rendering paths.
 */

const PREPARED_SCENES = new WeakSet();

const originalSetPixelRatio =
  THREE.WebGLRenderer.prototype.setPixelRatio;

THREE.WebGLRenderer.prototype.setPixelRatio =
  function setWalkthroughPixelRatio(value) {
    // The walkthrough is a large 3D canvas. 1.25 gives a substantial
    // pixel/fragment reduction on 2x-DPR displays while remaining crisp.
    const capped = Math.min(
      Number.isFinite(value) ? value : 1,
      1.25,
    );

    return originalSetPixelRatio.call(
      this,
      capped,
    );
  };

function countMeshes(root) {
  let count = 0;

  root.traverse((object) => {
    if (object.isMesh) count += 1;
  });

  return count;
}

function findVisualModelRoot(scene) {
  let best = null;
  let bestCount = 0;

  for (const child of scene.children) {
    if (
      child.isLight ||
      child.isCamera ||
      child.userData?.isNavigationSurface
    ) {
      continue;
    }

    const meshCount = countMeshes(child);

    if (meshCount > bestCount) {
      best = child;
      bestCount = meshCount;
    }
  }

  return best;
}

function prepareStaticVisualModel(model) {
  if (!model || PREPARED_SCENES.has(model)) {
    return;
  }

  PREPARED_SCENES.add(model);

  model.traverse((object) => {
    if (!object.isMesh) {
      return;
    }

    // Re-enable normal view-frustum culling.
    object.frustumCulled = true;

    // Walkthrough geometry is static. Freeze local transform updates so the
    // CPU does not rebuild thousands of matrices every render frame.
    if (
      object.parent &&
      !object.userData?.hciDynamicObject
    ) {
      object.updateMatrix();
      object.matrixAutoUpdate = false;
      object.matrixWorldNeedsUpdate = true;
    }
  });

  model.updateMatrixWorld(true);

  // Use the actual model bounds to avoid a needlessly gigantic 5000-unit
  // camera far plane on ordinary residential/architectural scenes.
  const box = new THREE.Box3().setFromObject(
    model,
  );

  if (!box.isEmpty()) {
    const sphere = box.getBoundingSphere(
      new THREE.Sphere(),
    );

    if (
      Number.isFinite(sphere.radius) &&
      sphere.radius > 0
    ) {
      model.userData.hciRecommendedCameraFar =
        THREE.MathUtils.clamp(
          sphere.radius * 4,
          250,
          2500,
        );
    }
  }
}

const originalRender =
  THREE.WebGLRenderer.prototype.render;

THREE.WebGLRenderer.prototype.render =
  function renderWalkthroughOptimized(
    scene,
    camera,
  ) {
    if (
      scene &&
      scene.isScene &&
      !scene.userData?.hciPerformancePrepared
    ) {
      scene.userData.hciPerformancePrepared =
        true;

      const model = findVisualModelRoot(scene);

      if (model) {
        prepareStaticVisualModel(model);

        const recommendedFar =
          model.userData
            ?.hciRecommendedCameraFar;

        if (
          Number.isFinite(recommendedFar) &&
          camera &&
          camera.isPerspectiveCamera
        ) {
          camera.far = Math.min(
            camera.far,
            recommendedFar,
          );
          camera.updateProjectionMatrix();
        }
      }
    }

    return originalRender.call(
      this,
      scene,
      camera,
    );
  };
