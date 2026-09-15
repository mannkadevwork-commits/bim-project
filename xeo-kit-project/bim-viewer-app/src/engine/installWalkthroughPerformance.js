import * as THREE from 'three';

const PREPARED_SCENES = new WeakSet();

const originalSetPixelRatio =
  THREE.WebGLRenderer.prototype.setPixelRatio;

THREE.WebGLRenderer.prototype.setPixelRatio =
  function setWalkthroughPixelRatio(value) {
    const numeric =
      Number.isFinite(value)
        ? value
        : 1;

    const capped =
      Math.min(
        numeric,
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
    if (object.isMesh) {
      count += 1;
    }
  });

  return count;
}

function findVisualModelRoot(scene) {
  let best = null;
  let bestCount = 0;

  for (
    const child of scene.children
  ) {
    if (
      child.isLight ||
      child.isCamera ||
      child.userData?.isNavigationSurface
    ) {
      continue;
    }

    const meshCount =
      countMeshes(child);

    if (meshCount > bestCount) {
      best = child;
      bestCount = meshCount;
    }
  }

  return best;
}

function prepareStaticVisualModel(model) {
  if (
    !model ||
    PREPARED_SCENES.has(model)
  ) {
    return;
  }

  PREPARED_SCENES.add(model);

  model.traverse((object) => {
    if (!object.isMesh) {
      return;
    }

    object.frustumCulled = true;

    // The existing HCI model does not animate mesh transforms during the
    // walkthrough. Freeze local matrix recomputation after the GLB is loaded.
    if (
      !object.userData?.hciDynamicObject
    ) {
      object.updateMatrix();
      object.matrixAutoUpdate = false;
    }
  });

  model.updateMatrixWorld(true);

  // Cache a practical camera far distance from the real model bounds.
  // This is only a projection hint; it does not alter navigation.
  const box =
    new THREE.Box3().setFromObject(
      model,
    );

  if (box.isEmpty()) {
    return;
  }

  const sphere =
    box.getBoundingSphere(
      new THREE.Sphere(),
    );

  if (
    Number.isFinite(
      sphere.radius,
    ) &&
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

const originalRender =
  THREE.WebGLRenderer.prototype.render;

THREE.WebGLRenderer.prototype.render =
  function renderWalkthroughOptimized(
    scene,
    camera,
  ) {
    if (
      scene?.isScene &&
      !scene.userData?.hciPerformancePrepared
    ) {
      scene.userData.hciPerformancePrepared =
        true;

      const model =
        findVisualModelRoot(
          scene,
        );

      if (model) {
        prepareStaticVisualModel(
          model,
        );

        const far =
          model.userData
            ?.hciRecommendedCameraFar;

        if (
          Number.isFinite(far) &&
          camera?.isPerspectiveCamera
        ) {
          camera.far = Math.min(
            camera.far,
            far,
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
