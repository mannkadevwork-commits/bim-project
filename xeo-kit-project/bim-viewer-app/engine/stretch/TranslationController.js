import { math } from '@xeokit/xeokit-sdk/src/viewer/scene/math/math';

/**
 * Casts a ray from the mouse through the camera and intersects it with a 
 * perfectly horizontal plane at the target object's current elevation.
 */
export const calculateGrabPoint = (viewerRef, canvas, canvasPos, elevationY) => {
    const viewer = viewerRef.current;
    const worldRayOrigin = math.vec3();
    const worldRayDir = math.vec3();

    math.canvasPosToWorldRay(
        canvas,
        viewer.scene.camera.viewMatrix,
        viewer.scene.camera.projMatrix,
        canvasPos,
        worldRayOrigin,
        worldRayDir
    );

    const hitPoint = math.vec3();
    math.rayPlaneIntersect(
        worldRayOrigin,
        worldRayDir,
        [0, elevationY, 0],
        [1, elevationY, 0],
        [0, elevationY, 1],
        hitPoint
    );

    return hitPoint;
};

/**
 * Safely applies a pure translation transform based on the target type.
 * Asset Models use .position, Native structural elements use .offset.
 */
export const applyTranslation = (viewerRef, targetId, isAsset, newPosition) => {
    const viewer = viewerRef.current;
    
    if (isAsset) {
        const model = viewer.scene.models[targetId];
        if (model) model.position = newPosition;
    } else {
        const entity = viewer.scene.objects[targetId];
        if (entity) entity.offset = newPosition;
    }
};