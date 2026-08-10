// Reliable standard 3D Unprojection Math replacing faulty Xeokit intersects
export const mat4Mul = (a, b) => {
    const o = new Array(16);
    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
            let s = 0;
            for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
            o[c * 4 + r] = s;
        }
    }
    return o;
};

export const mat4Invert = (m) => {
    const inv = new Array(16);
    inv[0]=m[5]*m[10]*m[15]-m[5]*m[11]*m[14]-m[9]*m[6]*m[15]+m[9]*m[7]*m[14]+m[13]*m[6]*m[11]-m[13]*m[7]*m[10];
    inv[4]=-m[4]*m[10]*m[15]+m[4]*m[11]*m[14]+m[8]*m[6]*m[15]-m[8]*m[7]*m[14]-m[12]*m[6]*m[11]+m[12]*m[7]*m[10];
    inv[8]=m[4]*m[9]*m[15]-m[4]*m[11]*m[13]-m[8]*m[5]*m[15]+m[8]*m[7]*m[13]+m[12]*m[5]*m[11]-m[12]*m[7]*m[9];
    inv[12]=-m[4]*m[9]*m[14]+m[4]*m[10]*m[13]+m[8]*m[5]*m[14]-m[8]*m[6]*m[13]-m[12]*m[5]*m[10]+m[12]*m[6]*m[9];
    inv[1]=-m[1]*m[10]*m[15]+m[1]*m[11]*m[14]+m[9]*m[2]*m[15]-m[9]*m[3]*m[14]-m[13]*m[2]*m[11]+m[13]*m[3]*m[10];
    inv[5]=m[0]*m[10]*m[15]-m[0]*m[11]*m[14]-m[8]*m[2]*m[15]+m[8]*m[3]*m[14]+m[12]*m[2]*m[11]-m[12]*m[3]*m[10];
    inv[9]=-m[0]*m[9]*m[15]+m[0]*m[11]*m[13]+m[8]*m[1]*m[15]-m[8]*m[3]*m[13]-m[12]*m[1]*m[11]+m[12]*m[3]*m[9];
    inv[13]=m[0]*m[9]*m[14]-m[0]*m[10]*m[13]-m[8]*m[1]*m[14]+m[8]*m[2]*m[13]+m[12]*m[1]*m[10]-m[12]*m[2]*m[9];
    inv[2]=m[1]*m[6]*m[15]-m[1]*m[7]*m[14]-m[5]*m[2]*m[15]+m[5]*m[3]*m[14]+m[13]*m[2]*m[7]-m[13]*m[3]*m[6];
    inv[6]=-m[0]*m[6]*m[15]+m[0]*m[7]*m[14]+m[4]*m[2]*m[15]-m[4]*m[3]*m[14]-m[12]*m[2]*m[7]+m[12]*m[3]*m[6];
    inv[10]=m[0]*m[5]*m[15]-m[0]*m[7]*m[13]-m[4]*m[1]*m[15]+m[4]*m[3]*m[13]+m[12]*m[1]*m[7]-m[12]*m[3]*m[5];
    inv[14]=-m[0]*m[5]*m[14]+m[0]*m[6]*m[13]+m[4]*m[1]*m[14]-m[4]*m[2]*m[13]-m[12]*m[1]*m[6]+m[12]*m[2]*m[5];
    inv[3]=-m[1]*m[6]*m[11]+m[1]*m[7]*m[10]+m[5]*m[2]*m[11]-m[5]*m[3]*m[10]-m[9]*m[2]*m[7]+m[9]*m[3]*m[6];
    inv[7]=m[0]*m[6]*m[11]-m[0]*m[7]*m[10]-m[4]*m[2]*m[11]+m[4]*m[3]*m[10]+m[8]*m[2]*m[7]-m[8]*m[3]*m[6];
    inv[11]=-m[0]*m[5]*m[11]+m[0]*m[7]*m[9]+m[4]*m[1]*m[11]-m[4]*m[3]*m[9]-m[8]*m[1]*m[7]+m[8]*m[3]*m[5];
    inv[15]=m[0]*m[5]*m[10]-m[0]*m[6]*m[9]-m[4]*m[1]*m[10]+m[4]*m[2]*m[9]+m[8]*m[1]*m[6]-m[8]*m[2]*m[5];
    let det = m[0]*inv[0] + m[1]*inv[4] + m[2]*inv[8] + m[3]*inv[12];
    if (!det) return null;
    det = 1.0 / det;
    return inv.map(v => v * det);
};

export const transformVec4 = (m, v) => [
    m[0]*v[0] + m[4]*v[1] + m[8]*v[2]  + m[12]*v[3],
    m[1]*v[0] + m[5]*v[1] + m[9]*v[2]  + m[13]*v[3],
    m[2]*v[0] + m[6]*v[1] + m[10]*v[2] + m[14]*v[3],
    m[3]*v[0] + m[7]*v[1] + m[11]*v[2] + m[15]*v[3],
];

export const unprojectToWorld = (px, py, ndcZ, invViewProj, w, h) => {
    const ndcX = (px / w) * 2 - 1;
    const ndcY = 1 - (py / h) * 2;
    const world = transformVec4(invViewProj, [ndcX, ndcY, ndcZ, 1]);
    return [world[0] / world[3], world[1] / world[3], world[2] / world[3]];
};

export const intersectXZPlane = (px, py, invViewProj, planeY, w, h) => {
    const near = unprojectToWorld(px, py, -1, invViewProj, w, h);
    const far = unprojectToWorld(px, py, 1, invViewProj, w, h);
    const rd = [far[0] - near[0], far[1] - near[1], far[2] - near[2]];
    if (Math.abs(rd[1]) < 1e-9) return null;
    const t = (planeY - near[1]) / rd[1];
    return [near[0] + t * rd[0], near[1] + t * rd[1], near[2] + t * rd[2]];
};

export const calculateGrabPoint = (viewerRef, canvas, canvasPos, elevationY) => {
    try {
        const viewer = viewerRef.current;
        const camera = viewer.scene.camera;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        const viewProj = mat4Mul(camera.project.matrix, camera.viewMatrix);
        const inv = mat4Invert(viewProj);
        if (!inv) return null;
        return intersectXZPlane(canvasPos[0], canvasPos[1], inv, elevationY, w, h);
    } catch (e) {
        return null;
    }
};

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