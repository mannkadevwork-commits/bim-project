// Home Tour follows a validated NavMesh route, then composes a separate
// room-local 360° camera presentation. These values are intentionally
// independent of Explore/Guided navigation tuning.
export const HOME_TOUR_ROUTE_REQUEST_TIMEOUT_MS = 8_000;
export const HOME_TOUR_PLANNER_VERSION = 'navmesh-zone-tour-v2.2';
export const HOME_TOUR_ROUTE_CONTRACT = 'hci.home-tour.navigation-zones.v2';
export const HOME_TOUR_CRUISE_SPEED_MPS = 0.82;
export const HOME_TOUR_FIXED_FOV_DEGREES = 70;
export const HOME_TOUR_CAMERA_PITCH = -0.15;
export const HOME_TOUR_LOOK_AHEAD_METERS = 0.72;
export const HOME_TOUR_HERO_REVEAL_MS = 3_600;
export const HOME_TOUR_SWEEP_DEGREES_PER_SECOND = 6; // A genuinely open 360° room takes 60 seconds; obstructed rooms use a shorter arc.
export const HOME_TOUR_SWEEP_SAMPLE_COUNT = 48;
export const HOME_TOUR_SWEEP_MAX_DEGREES = 220;
export const HOME_TOUR_SWEEP_MIN_DEGREES = 35;
export const HOME_TOUR_SWEEP_OPEN_SCORE_THRESHOLD = -0.75;
export const HOME_TOUR_PAUSE_DRIFT_CYCLE_MS = 24_000;
export const HOME_TOUR_PAUSE_DRIFT_YAW_DEGREES = 3.2;
export const HOME_TOUR_PAUSE_DRIFT_PITCH_DEGREES = 1.6;
export const HOME_TOUR_MIN_CLEARANCE_METERS = 0.32;
// Begin with a restrained downward architectural angle (never tilt up to the ceiling),
// then lower the frame toward the selected furniture hero.
export const HOME_TOUR_TOP_REVEAL_PITCH = (-10 * Math.PI) / 180;
export const HOME_TOUR_PRESENTATION_BASE_PITCH = (-24 * Math.PI) / 180;
export const HOME_TOUR_MIN_HERO_PITCH = (-32 * Math.PI) / 180;
// Keep every room presentation looking down into the design, never level/up at a wall.
export const HOME_TOUR_MAX_HERO_PITCH = (-18 * Math.PI) / 180;

export function homeTourCameraTurnRate(phase) {
  if (phase === 'paused') return 0.34;
  if (phase === 'revealing') return 1.65;
  if (phase === 'sweeping') return 2.8;
  if (phase === 'traveling') return 2.4;
  if (phase === 'planning') return 2.2;
  return 1.8;
}

/** Three.js camera yaw for a world-space X/Z direction (camera looks down -Z). */
export function homeTourYawFromDirection(dx, dz) {
  if (!Number.isFinite(dx) || !Number.isFinite(dz) || Math.hypot(dx, dz) < 1e-7) return null;
  return Math.atan2(-dx, -dz);
}

/** Interpolate yaw on the short angular arc across the +/- PI seam. */
export function homeTourAngleLerp(from, to, alpha) {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return Number.isFinite(to) ? to : from;
  const t = Math.max(0, Math.min(1, Number(alpha) || 0));
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + delta * t;
}

export function homeTourAngleDelta(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

/**
 * Choose the best initial room heading before the panorama starts.
 * Structural openness is measured by the runtime's wall-ray score; locally
 * owned visible subjects add a framing bonus. When there are no safe subjects,
 * the most open direction wins instead of inheriting a route tangent into a wall.
 */
export function selectHomeTourCompositionHeading({
  origin,
  currentYaw = 0,
  subjects = [],
  opennessScore = null,
  opennessAvailable = typeof opennessScore === 'function',
  sampleCount = 36,
} = {}) {
  if (!origin || ![origin.x, origin.z].every((value) => Number.isFinite(Number(value)))) {
    return {
      yaw: Number.isFinite(currentYaw) ? currentYaw : 0,
      subjectId: null,
      score: 0,
      headingSamples: [],
      opennessReliable: Boolean(opennessAvailable),
    };
  }

  const candidateYaws = new Map();
  const addYaw = (yaw) => {
    if (!Number.isFinite(yaw)) return;
    const normalized = Math.atan2(Math.sin(yaw), Math.cos(yaw));
    candidateYaws.set(normalized.toFixed(6), normalized);
  };
  const count = Math.max(12, Math.min(72, Math.floor(Number(sampleCount) || 36)));
  const baseHeadingYaws = [];
  for (let index = 0; index < count; index += 1) {
    const yaw = (Number.isFinite(currentYaw) ? currentYaw : 0) + (Math.PI * 2 * index) / count;
    addYaw(yaw);
    baseHeadingYaws.push(Math.atan2(Math.sin(yaw), Math.cos(yaw)));
  }

  const preparedSubjects = (Array.isArray(subjects) ? subjects : []).map((subject) => {
    const center = subject?.center;
    if (!center || ![center.x, center.y, center.z].every((value) => Number.isFinite(Number(value)))) return null;
    const dx = Number(center.x) - Number(origin.x);
    const dz = Number(center.z) - Number(origin.z);
    const distance = Math.hypot(dx, dz);
    const yaw = homeTourYawFromDirection(dx, dz);
    if (!Number.isFinite(yaw) || distance < 0.35) return null;
    addYaw(yaw);
    return {
      id: subject.id == null ? null : String(subject.id),
      yaw,
      distance,
      priority: Math.max(0.25, Math.min(1.25, (Number(subject.priority) || 5) / 8)),
    };
  }).filter(Boolean);

  let best = null;
  const opennessByYaw = new Map();
  for (const yaw of candidateYaws.values()) {
    let openness = 0;
    if (typeof opennessScore === 'function') {
      try {
        const measured = Number(opennessScore(yaw));
        if (Number.isFinite(measured)) openness = measured;
      } catch { /* A failed optional ray probe must not break Home Tour. */ }
    }
    opennessByYaw.set(yaw.toFixed(6), openness);
    // Map the existing wall-guard range (roughly -6.6..+1.35) into 0..1.
    const opennessQuality = homeTourClamp((openness + 6.6) / 8, 0, 1);
    let subjectScore = 0;
    let primarySubjectId = null;
    let primarySubjectScore = -Infinity;
    for (const subject of preparedSubjects) {
      const angle = Math.abs(homeTourAngleDelta(yaw, subject.yaw));
      const halfFov = (62 * Math.PI) / 180;
      if (angle > halfFov) continue;
      const alignment = Math.max(0, Math.cos(angle));
      const distanceQuality = homeTourClamp(1 - Math.abs(subject.distance - 2.8) / 6, 0.12, 1);
      const score = subject.priority * (0.35 + alignment * 0.9) * distanceQuality;
      subjectScore += score;
      if (score > primarySubjectScore) {
        primarySubjectScore = score;
        primarySubjectId = subject.id;
      }
    }
    const currentHeadingPenalty = Math.abs(homeTourAngleDelta(currentYaw, yaw)) * 0.025;
    const score = opennessQuality * 1.8 + subjectScore * 1.7 - currentHeadingPenalty;
    const candidate = { yaw, subjectId: primarySubjectId, score };
    if (!best || candidate.score > best.score + 1e-9
      || (Math.abs(candidate.score - best.score) <= 1e-9
        && Math.abs(homeTourAngleDelta(currentYaw, candidate.yaw)) < Math.abs(homeTourAngleDelta(currentYaw, best.yaw)))) {
      best = candidate;
    }
  }

  const headingSamples = baseHeadingYaws.map((yaw) => ({
    yaw,
    openness: opennessByYaw.get(yaw.toFixed(6)) ?? 0,
  }));
  return {
    ...(best || { yaw: Number.isFinite(currentYaw) ? currentYaw : 0, subjectId: null, score: 0 }),
    headingSamples,
    opennessReliable: Boolean(opennessAvailable),
  };
}

/**
 * Select a continuous room-viewing arc from the wall-ray samples collected
 * during composition. A full revolution is reserved for genuinely open rooms
 * whose useful subjects surround the camera; otherwise the camera scans only
 * the best unobstructed sector and never deliberately turns into a nearby wall.
 */
export function selectHomeTourViewingArc({
  headingSamples = [],
  preferredYaw = 0,
  subjects = [],
  opennessReliable = false,
  openScoreThreshold = HOME_TOUR_SWEEP_OPEN_SCORE_THRESHOLD,
  minSweepDegrees = HOME_TOUR_SWEEP_MIN_DEGREES,
  maxSweepDegrees = HOME_TOUR_SWEEP_MAX_DEGREES,
} = {}) {
  const samples = Array.isArray(headingSamples)
    ? headingSamples.filter((sample) => Number.isFinite(sample?.yaw) && Number.isFinite(sample?.openness))
    : [];
  const sampleCount = samples.length;
  const fallbackYaw = Number.isFinite(preferredYaw) ? preferredYaw : 0;
  if (sampleCount < 12) {
    return {
      startYaw: fallbackYaw,
      direction: 1,
      rotationRadians: (90 * Math.PI) / 180,
      fullCircle: false,
      averageOpenness: 0,
      coveredSubjectIds: [],
    };
  }

  const stepDegrees = 360 / sampleCount;
  const maxSteps = Math.max(1, Math.min(sampleCount - 1, Math.floor(maxSweepDegrees / stepDegrees)));
  const open = samples.map((sample) => sample.openness >= openScoreThreshold);
  const allDirectionsOpen = open.every(Boolean);
  const preparedSubjects = (Array.isArray(subjects) ? subjects : []).map((subject) => {
    const yaw = Number(subject?.yaw);
    if (!Number.isFinite(yaw)) return null;
    return {
      id: subject.id == null ? null : String(subject.id),
      yaw: Math.atan2(Math.sin(yaw), Math.cos(yaw)),
      priority: Math.max(0.25, Math.min(1.5, (Number(subject.priority) || 5) / 8)),
    };
  }).filter(Boolean);

  // A complete panorama is only worthwhile when every sampled direction is
  // clear and room content is distributed around at least three quadrants.
  const subjectQuadrants = new Set(preparedSubjects.map((subject) => {
    const normalized = (subject.yaw + Math.PI * 2) % (Math.PI * 2);
    return Math.floor(normalized / (Math.PI / 2)) % 4;
  }));
  if (opennessReliable && allDirectionsOpen && preparedSubjects.length >= 4 && subjectQuadrants.size >= 3) {
    return {
      startYaw: fallbackYaw,
      direction: 1,
      rotationRadians: Math.PI * 2,
      fullCircle: true,
      averageOpenness: samples.reduce((sum, sample) => sum + sample.openness, 0) / sampleCount,
      coveredSubjectIds: preparedSubjects.map((subject) => subject.id).filter(Boolean),
    };
  }

  const normalizedDistance = (a, b) => Math.abs(homeTourAngleDelta(a, b));
  const candidates = [];
  for (let startIndex = 0; startIndex < sampleCount; startIndex += 1) {
    if (!open[startIndex]) continue;
    const startYaw = samples[startIndex].yaw;
    for (const direction of [1, -1]) {
      let length = 0;
      let opennessTotal = 0;
      for (let offset = 0; offset < maxSteps; offset += 1) {
        const sampleIndex = (startIndex + direction * offset + sampleCount) % sampleCount;
        if (!open[sampleIndex]) break;
        opennessTotal += samples[sampleIndex].openness;
        length += 1;
      }
      const rotationSteps = Math.max(0, length - 1);
      const rotationDegrees = Math.min(maxSweepDegrees, rotationSteps * stepDegrees);
      if (rotationDegrees < minSweepDegrees) continue;
      const rotationRadians = (rotationDegrees * Math.PI) / 180;
      const coveredSubjectIds = [];
      let subjectScore = 0;
      for (const subject of preparedSubjects) {
        const directedOffset = (direction * homeTourAngleDelta(startYaw, subject.yaw) + Math.PI * 2) % (Math.PI * 2);
        if (directedOffset > rotationRadians) continue;
        const centerBias = 1 - Math.min(1, Math.abs(directedOffset - rotationRadians * 0.52) / Math.max(rotationRadians * 0.68, 1e-4));
        subjectScore += subject.priority * (0.55 + centerBias * 0.45);
        if (subject.id) coveredSubjectIds.push(subject.id);
      }
      const averageOpenness = opennessTotal / Math.max(1, length);
      const startPenalty = normalizedDistance(startYaw, fallbackYaw) / Math.PI;
      const lengthQuality = rotationDegrees / Math.max(1, maxSweepDegrees);
      const score = averageOpenness * 0.24 + subjectScore * 1.35 + lengthQuality * 0.5 - startPenalty * 0.7;
      candidates.push({
        startYaw,
        direction,
        rotationRadians,
        fullCircle: false,
        averageOpenness,
        coveredSubjectIds,
        score,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score
    || normalizedDistance(a.startYaw, fallbackYaw) - normalizedDistance(b.startYaw, fallbackYaw)
    || b.rotationRadians - a.rotationRadians
    || b.direction - a.direction);
  if (candidates.length) return candidates[0];

  // A tightly enclosed or badly occluded stop gets a short look toward its
  // single best heading, not a blind spin through known obstructions.
  const bestIndex = samples.reduce((best, sample, index) => (
    sample.openness > samples[best].openness ? index : best
  ), 0);
  return {
    startYaw: samples[bestIndex].yaw,
    direction: 1,
    rotationRadians: (24 * Math.PI) / 180,
    fullCircle: false,
    averageOpenness: samples[bestIndex].openness,
    coveredSubjectIds: [],
    constrained: true,
  };
}

function homeTourClamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function homeTourSmooth01(value) {
  const t = homeTourClamp(Number(value) || 0, 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Build a room-local camera shot. A verified hero sets the initial reveal,
 * then verified local subjects provide pitch cues during a visibility-aware
 * sweep. No subject from a neighboring/ambiguous zone is admitted here.
 */
export function buildHomeTourPresentationShot({
  origin,
  eyeHeightMeters = 1.68,
  metersPerUnit = 1,
  currentYaw = 0,
  hero = null,
  fallbackTarget = null,
  subjects = [],
  headingSamples = [],
  opennessReliable = false,
}) {
  const start = origin && [origin.x, origin.y, origin.z].every((value) => Number.isFinite(Number(value)))
    ? { x: Number(origin.x), y: Number(origin.y), z: Number(origin.z) }
    : null;
  const unit = Number(metersPerUnit);
  if (!start || !Number.isFinite(unit) || unit <= 0) return null;

  const heroCenter = hero?.center && [hero.center.x, hero.center.y, hero.center.z].every((value) => Number.isFinite(Number(value)))
    ? { x: Number(hero.center.x), y: Number(hero.center.y), z: Number(hero.center.z) }
    : null;
  const fallbackCenter = fallbackTarget && [fallbackTarget.x, fallbackTarget.y, fallbackTarget.z].every((value) => Number.isFinite(Number(value)))
    ? { x: Number(fallbackTarget.x), y: Number(fallbackTarget.y), z: Number(fallbackTarget.z) }
    : null;
  const aimCenter = heroCenter || fallbackCenter;
  const eyeY = start.y + Math.max(0, Number(eyeHeightMeters) || 1.68) * unit;
  let heroYaw = Number.isFinite(currentYaw) ? currentYaw : 0;
  let heroPitch = HOME_TOUR_PRESENTATION_BASE_PITCH;

  if (aimCenter) {
    const dx = aimCenter.x - start.x;
    const dz = aimCenter.z - start.z;
    const horizontalDistance = Math.hypot(dx, dz);
    const resolvedYaw = homeTourYawFromDirection(dx, dz);
    if (Number.isFinite(resolvedYaw)) heroYaw = resolvedYaw;
    if (horizontalDistance > 0.12 * unit) {
      heroPitch = homeTourClamp(
        Math.atan2(aimCenter.y - eyeY, horizontalDistance),
        HOME_TOUR_MIN_HERO_PITCH,
        HOME_TOUR_MAX_HERO_PITCH,
      );
    }
  }

  // Build room-local aim cues for the visible sector. Every cue has already
  // passed zone ownership and line-of-sight validation in the director.
  const panoramaTargets = (Array.isArray(subjects) ? subjects : [])
    .map((subject) => {
      const center = subject?.center;
      if (!center || ![center.x, center.y, center.z].every((value) => Number.isFinite(Number(value)))) return null;
      const dx = Number(center.x) - start.x;
      const dz = Number(center.z) - start.z;
      const horizontalDistance = Math.hypot(dx, dz);
      const yaw = homeTourYawFromDirection(dx, dz);
      if (!Number.isFinite(yaw) || horizontalDistance < 0.12 * unit) return null;
      const pitch = homeTourClamp(
        Math.atan2(Number(center.y) - eyeY, horizontalDistance),
        HOME_TOUR_MIN_HERO_PITCH,
        HOME_TOUR_MAX_HERO_PITCH,
      );
      return {
        id: subject.id || null,
        name: String(subject.name || subject.label || 'Room element'),
        yaw,
        pitch,
        priority: Number(subject.priority) || 5,
      };
    })
    .filter(Boolean);

  const arcSubjects = panoramaTargets.map((subject) => ({
    id: subject.id,
    yaw: subject.yaw,
    center: { x: 0, y: 0, z: -1 },
    priority: subject.priority,
  }));
  const viewingArc = selectHomeTourViewingArc({
    headingSamples,
    preferredYaw: heroYaw,
    subjects: arcSubjects,
    opennessReliable,
  });
  const sweepStartYaw = Number.isFinite(viewingArc.startYaw) ? viewingArc.startYaw : heroYaw;
  const sweepTravelRadians = Math.max(0, Number(viewingArc.rotationRadians) || 0);
  const sweepDirection = viewingArc.direction === -1 ? -1 : 1;
  const scopedPanoramaTargets = panoramaTargets
    .map((subject) => {
      const directedOffset = (sweepDirection * homeTourAngleDelta(sweepStartYaw, subject.yaw) + Math.PI * 2) % (Math.PI * 2);
      return { ...subject, yawOffset: directedOffset };
    })
    .filter((subject) => subject.yawOffset <= sweepTravelRadians + 1e-4)
    .sort((a, b) => a.yawOffset - b.yawOffset || String(a.id).localeCompare(String(b.id)));
  const sweepDurationMs = (sweepTravelRadians / ((HOME_TOUR_SWEEP_DEGREES_PER_SECOND * Math.PI) / 180)) * 1000;

  return {
    hero: hero ? {
      id: hero.id || null,
      name: String(hero.name || hero.label || 'Room highlight'),
      areaId: hero.areaId || null,
    } : null,
    heroYaw: sweepStartYaw,
    heroPitch,
    topPitch: HOME_TOUR_TOP_REVEAL_PITCH,
    sweepBasePitch: homeTourClamp(heroPitch, (-28 * Math.PI) / 180, (-21 * Math.PI) / 180),
    panoramaTargets: scopedPanoramaTargets,
    sweepDurationMs: Math.max(1_000, Math.round(sweepDurationMs)),
    sweepRotationRadians: sweepTravelRadians,
    sweepDirection,
    sweepFullCircle: Boolean(viewingArc.fullCircle),
    sweepConstrained: Boolean(viewingArc.constrained),
    relevantSubjectCount: scopedPanoramaTargets.length,
  };
}

/** A gentle downward room reveal while the camera eases onto the selected hero. */
export function homeTourRevealPose(progress, { fromYaw = 0, toYaw = 0, heroPitch = HOME_TOUR_PRESENTATION_BASE_PITCH } = {}) {
  const eased = homeTourSmooth01(progress);
  return {
    yaw: homeTourAngleLerp(fromYaw, toYaw, eased),
    pitch: HOME_TOUR_TOP_REVEAL_PITCH + (heroPitch - HOME_TOUR_TOP_REVEAL_PITCH) * eased,
  };
}

/**
 * One slow, continuous 360° room sweep. The yaw remains monotonic for the
 * full revolution; pitch eases toward each verified subject as its bearing
 * enters the camera's presentation cone. The tour advances at completion.
 */
export function homeTourRoomSweepPose(progress, sweepConfig = {}) {
  const t = homeTourClamp(Number(progress) || 0, 0, 1);
  const rotationRadians = Number.isFinite(sweepConfig?.rotationRadians)
    ? Math.max(0, Number(sweepConfig.rotationRadians))
    : Math.PI * 2;
  // Smoothstep gives the pan a gentle acceleration and deceleration instead of
  // starting/stopping abruptly. Obstructed stops use a limited visible arc.
  const easedYawProgress = homeTourSmooth01(t);
  const direction = sweepConfig?.direction === -1 ? -1 : 1;
  const yawOffset = direction * rotationRadians * easedYawProgress;
  const directedSweepProgress = Math.abs(yawOffset);
  const basePitch = Number.isFinite(sweepConfig?.basePitch)
    ? homeTourClamp(Number(sweepConfig.basePitch), HOME_TOUR_MIN_HERO_PITCH, HOME_TOUR_MAX_HERO_PITCH)
    : HOME_TOUR_PRESENTATION_BASE_PITCH;
  const targets = Array.isArray(sweepConfig?.targets) ? sweepConfig.targets : [];
  const influenceRadians = (30 * Math.PI) / 180;
  let weightedPitch = 0;
  let totalWeight = 0;

  for (const target of targets) {
    const targetOffset = Number(target?.yawOffset);
    const targetPitch = Number(target?.pitch);
    if (!Number.isFinite(targetOffset) || !Number.isFinite(targetPitch)) continue;
    const rawDelta = Math.abs(targetOffset - directedSweepProgress) % (Math.PI * 2);
    const angularDistance = Math.min(rawDelta, Math.PI * 2 - rawDelta);
    if (angularDistance >= influenceRadians) continue;
    const normalized = 1 - angularDistance / influenceRadians;
    const weight = normalized * normalized * (3 - 2 * normalized);
    weightedPitch += homeTourClamp(targetPitch, HOME_TOUR_MIN_HERO_PITCH, HOME_TOUR_MAX_HERO_PITCH) * weight;
    totalWeight += weight;
  }

  // Keep subject tracking subtle. The dominant shot is an architectural
  // top-to-bottom composition; individual objects only nudge the tilt slightly.
  const subjectWeight = Math.min(0.32, totalWeight * 0.22);
  const pitch = totalWeight > 0
    ? basePitch + (weightedPitch / totalWeight - basePitch) * subjectWeight
    : basePitch;
  return { yawOffset, pitch };
}

/**
 * A subtle ambient hold motion used only while Home Tour playback is paused.
 * It traces a very shallow V through yaw/pitch space so the shot stays alive
 * without advancing the route, room index, reveal or panorama clocks.
 */
export function homeTourPausedCameraPose(elapsedMs, {
  baseYaw = 0,
  basePitch = HOME_TOUR_PRESENTATION_BASE_PITCH,
  cycleMs = HOME_TOUR_PAUSE_DRIFT_CYCLE_MS,
} = {}) {
  const cycle = Math.max(8_000, Number(cycleMs) || HOME_TOUR_PAUSE_DRIFT_CYCLE_MS);
  const elapsed = Math.max(0, Number(elapsedMs) || 0);
  const phase = (elapsed % cycle) / cycle;
  const segmentProgress = phase < 0.5 ? phase * 2 : (phase - 0.5) * 2;
  const eased = homeTourSmooth01(segmentProgress);
  const horizontalProgress = phase < 0.5 ? eased : 1 - eased;
  const lateral = -1 + horizontalProgress * 2;
  const depth = Math.sin(Math.PI * horizontalProgress);
  const yawOffset = lateral * (HOME_TOUR_PAUSE_DRIFT_YAW_DEGREES * Math.PI / 180);
  const pitchOffset = -(0.25 + depth * HOME_TOUR_PAUSE_DRIFT_PITCH_DEGREES) * Math.PI / 180;
  return {
    yaw: (Number.isFinite(baseYaw) ? baseYaw : 0) + yawOffset,
    pitch: homeTourClamp(
      (Number.isFinite(basePitch) ? basePitch : HOME_TOUR_PRESENTATION_BASE_PITCH) + pitchOffset,
      (-34 * Math.PI) / 180,
      (8 * Math.PI) / 180,
    ),
    progress: horizontalProgress,
  };
}


/** Read a stable route tangent a short distance ahead of the current point. */
export function homeTourLookAheadDirection(path, startIndex, position, lookAheadDistance) {
  if (!Array.isArray(path) || path.length < 2 || !position
    || ![position.x, position.z, lookAheadDistance].every(Number.isFinite)) return null;

  const index = Math.max(0, Math.min(path.length - 1, Math.floor(Number(startIndex) || 0)));
  let cursorX = position.x;
  let cursorZ = position.z;
  let remaining = Math.max(0.12, lookAheadDistance);

  for (let i = index; i < path.length; i += 1) {
    const point = path[i];
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.z)) continue;
    const dx = point.x - cursorX;
    const dz = point.z - cursorZ;
    const length = Math.hypot(dx, dz);
    if (length < 1e-6) continue;
    if (length >= remaining) return { x: dx / length, z: dz / length };
    remaining -= length;
    cursorX = point.x;
    cursorZ = point.z;
  }

  const last = path[path.length - 1];
  const dx = Number(last?.x) - position.x;
  const dz = Number(last?.z) - position.z;
  const length = Math.hypot(dx, dz);
  return length > 1e-6 ? { x: dx / length, z: dz / length } : null;
}

/** Deterministically advance a camera point along a validated polyline. */
export function advanceHomeTourPolyline({ position, path, index = 0, distance = 0 }) {
  if (!position || !Array.isArray(path) || !path.length
    || ![position.x, position.y, position.z, distance].every(Number.isFinite)) {
    return { position, index, finished: true, direction: null };
  }

  let current = { x: position.x, y: position.y, z: position.z };
  let cursor = Math.max(0, Math.min(path.length, Math.floor(Number(index) || 0)));
  let remaining = Math.max(0, distance);
  let lastDirection = null;

  while (cursor < path.length) {
    const target = path[cursor];
    if (![target?.x, target?.y, target?.z].every(Number.isFinite)) {
      return { position: current, index: cursor, finished: true, direction: null, invalid: true };
    }
    const dx = target.x - current.x;
    const dy = target.y - current.y;
    const dz = target.z - current.z;
    const length = Math.hypot(dx, dy, dz);
    if (length <= 1e-7) {
      cursor += 1;
      continue;
    }
    lastDirection = { x: dx / length, y: dy / length, z: dz / length };
    if (remaining >= length) {
      current = { x: target.x, y: target.y, z: target.z };
      remaining -= length;
      cursor += 1;
      continue;
    }
    const ratio = remaining / length;
    current = {
      x: current.x + dx * ratio,
      y: current.y + dy * ratio,
      z: current.z + dz * ratio,
    };
    remaining = 0;
    break;
  }

  return {
    position: current,
    index: cursor,
    finished: cursor >= path.length,
    direction: lastDirection,
  };
}

const HOME_TOUR_LOCAL_ROLE_PENALTY = Object.freeze({
  viewpoint: 0,
  'room-center': 0.045,
  'room-entrance': 0.12,
});

function homeTourPoint(value) {
  const x = Number(Array.isArray(value) ? value[0] : value?.x);
  const y = Number(Array.isArray(value) ? value[1] : value?.y);
  const z = Number(Array.isArray(value) ? value[2] : value?.z);
  return [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
}

function homeTourDistance3D(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function homeTourDistanceXZ(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function normalizeHomeTourAreas(areas, hotspots) {
  const validAreas = (Array.isArray(areas) ? areas : [])
    .filter((area) => area?.id && homeTourPoint(area.center))
    .map((area) => ({
      id: String(area.id),
      label: String(area.label || `Area ${area.id}`),
      center: homeTourPoint(area.center),
    }));
  if (validAreas.length) return validAreas;

  // Older walkthroughs may not have an `areas` array. Recover zones from
  // compiler-authored hotspot area IDs, never from presentation_rooms.json.
  const groups = new Map();
  for (const hotspot of Array.isArray(hotspots) ? hotspots : []) {
    const point = homeTourPoint(hotspot?.position);
    if (!point || !hotspot?.areaId) continue;
    const id = String(hotspot.areaId);
    if (!groups.has(id)) {
      groups.set(id, {
        id,
        label: String(hotspot.areaLabel || hotspot.label || `Area ${groups.size + 1}`),
        center: point,
      });
    }
    if (hotspot.presentationRole === 'room-center') groups.get(id).center = point;
  }
  return [...groups.values()];
}


/**
 * Assign a visual subject to a navigation zone only when the nearest zone
 * center is clearly closer than the runner-up. The compiler's current zones
 * are coarse navigation regions, not reconstructed room polygons; ambiguous
 * furniture is deliberately left unassigned rather than shown from a neighbor.
 */
export function resolveHomeTourSubjectZone(
  subjectPosition,
  zones,
  { metersPerUnit = 1, maxDistanceMeters = 4.5, minSeparationMeters = 0.5 } = {},
) {
  const point = homeTourPoint(subjectPosition);
  const unit = Number(metersPerUnit);
  if (!point || !Number.isFinite(unit) || unit <= 0) return null;
  const ranked = (Array.isArray(zones) ? zones : [])
    .filter((zone) => zone?.id && homeTourPoint(zone.center))
    .map((zone) => {
      const center = homeTourPoint(zone.center);
      return {
        id: String(zone.id),
        distanceMeters: homeTourDistanceXZ(point, center) / unit,
      };
    })
    .sort((a, b) => a.distanceMeters - b.distanceMeters || a.id.localeCompare(b.id));
  if (!ranked.length || ranked[0].distanceMeters > maxDistanceMeters) return null;
  if (ranked.length > 1 && ranked[1].distanceMeters - ranked[0].distanceMeters < minSeparationMeters) return null;
  return ranked[0].id;
}

function localCandidatePenalty(candidate) {
  return (HOME_TOUR_LOCAL_ROLE_PENALTY[candidate.role] ?? 0.25)
    + Math.max(0, 0.85 - candidate.clearanceMeters) * 0.42;
}

function buildLocalCandidates(area, hotspots, query, filter, unit) {
  const rawCandidates = (Array.isArray(hotspots) ? hotspots : [])
    .filter((hotspot) => String(hotspot?.areaId || '') === area.id)
    .filter((hotspot) => Object.hasOwn(HOME_TOUR_LOCAL_ROLE_PENALTY, hotspot?.presentationRole))
    .map((hotspot) => ({
      id: String(hotspot.id || `${area.id}-${hotspot.presentationRole}`),
      label: String(hotspot.label || area.label),
      role: hotspot.presentationRole,
      rawPoint: homeTourPoint(hotspot.position),
      clearanceMeters: Number(hotspot.clearanceMeters),
      score: Number(hotspot.score) || 0,
    }))
    .filter((candidate) => candidate.rawPoint
      && Number.isFinite(candidate.clearanceMeters)
      && candidate.clearanceMeters >= HOME_TOUR_MIN_CLEARANCE_METERS);

  const candidates = [];
  for (const candidate of rawCandidates) {
    let snapped;
    try {
      snapped = query.findClosestPoint(candidate.rawPoint, {
        halfExtents: { x: 0.36 * unit, y: 1.05 * unit, z: 0.36 * unit },
        filter,
      });
    } catch {
      snapped = null;
    }
    const point = snapped?.success && snapped.isPointOverPoly !== false
      ? homeTourPoint(snapped.point)
      : null;
    const snapDistanceMeters = point ? homeTourDistance3D(candidate.rawPoint, point) / unit : Infinity;
    if (!point || snapDistanceMeters > 0.22) continue;
    const effectiveClearance = candidate.clearanceMeters - snapDistanceMeters;
    if (effectiveClearance < HOME_TOUR_MIN_CLEARANCE_METERS) continue;
    const prepared = {
      ...candidate,
      point,
      clearanceMeters: effectiveClearance,
      snapDistanceMeters,
    };
    candidates.push({
      ...prepared,
      qualityPenalty: localCandidatePenalty(prepared),
    });
  }

  // A room-entrance hotspot is a way into a zone, not a presentation stop.
  // Keep it only for zones that have no validated interior center/viewpoint.
  const hasInteriorCandidate = candidates.some((candidate) => candidate.role !== 'room-entrance');
  const presentationCandidates = hasInteriorCandidate
    ? candidates.filter((candidate) => candidate.role !== 'room-entrance')
    : candidates;
  presentationCandidates.sort((a, b) => (
    a.qualityPenalty - b.qualityPenalty
    || b.clearanceMeters - a.clearanceMeters
    || a.id.localeCompare(b.id)
  ));
  const unique = [];
  for (const candidate of presentationCandidates) {
    if (unique.some((entry) => homeTourDistanceXZ(entry.point, candidate.point) < 0.24 * unit)) continue;
    unique.push(candidate);
    if (unique.length >= 3) break;
  }
  return unique;
}

function validateLocalPolylineOnNavMesh(points, query, filter, unit) {
  if (!Array.isArray(points) || points.length < 2) return true;
  const spacing = 0.40 * unit;
  for (let segmentIndex = 1; segmentIndex < points.length; segmentIndex += 1) {
    const a = points[segmentIndex - 1];
    const b = points[segmentIndex];
    const segmentLength = homeTourDistance3D(a, b);
    const sampleCount = Math.max(1, Math.ceil(segmentLength / spacing));
    for (let sampleIndex = 1; sampleIndex < sampleCount; sampleIndex += 1) {
      const t = sampleIndex / sampleCount;
      const sample = {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
      };
      let nearest;
      try {
        nearest = query.findClosestPoint(sample, {
          halfExtents: { x: 0.22 * unit, y: 0.45 * unit, z: 0.22 * unit },
          filter,
        });
      } catch {
        return false;
      }
      const projected = homeTourPoint(nearest?.point);
      if (!nearest?.success || !projected || nearest.isPointOverPoly === false) return false;
      if (homeTourDistanceXZ(sample, projected) > 0.18 * unit
        || Math.abs(sample.y - projected.y) > 0.20 * unit) return false;
    }
  }
  return true;
}

function buildLocalCompleteLeg(query, filter, from, fromId, candidate, unit, cache) {
  const key = `${fromId}>>${candidate.id}`;
  if (cache.has(key)) return cache.get(key);
  let result;
  try {
    result = query.computePath(from, candidate.point, {
      filter,
      maxStraightPathPoints: 512,
      maxPathPolys: 512,
    });
  } catch {
    cache.set(key, null);
    return null;
  }
  if (!result?.success || !Array.isArray(result.path) || !result.path.length) {
    cache.set(key, null);
    return null;
  }
  const points = result.path.map(homeTourPoint);
  if (points.some((point) => !point)
    || homeTourDistance3D(points[0], from) > 0.24 * unit) {
    cache.set(key, null);
    return null;
  }
  const endpoint = points[points.length - 1];
  if (homeTourDistanceXZ(endpoint, candidate.point) > 0.22 * unit
    || Math.abs(endpoint.y - candidate.point.y) > 0.18 * unit) {
    cache.set(key, null);
    return null;
  }

  const route = [];
  const append = (point) => {
    if (!route.length || homeTourDistance3D(route[route.length - 1], point) > 0.008 * unit) {
      route.push({ x: point.x, y: point.y, z: point.z });
    }
  };
  append(from);
  for (const point of points) append(point);
  route[route.length - 1] = { ...candidate.point };

  let length = 0;
  for (let index = 1; index < route.length; index += 1) {
    length += homeTourDistance3D(route[index - 1], route[index]);
  }
  const lengthMeters = length / unit;
  if (!validateLocalPolylineOnNavMesh(route, query, filter, unit)) {
    cache.set(key, null);
    return null;
  }
  const leg = {
    points: route,
    lengthMeters,
    objectiveCost: lengthMeters + candidate.qualityPenalty,
  };
  cache.set(key, leg);
  return leg;
}

function optimizeLocalZoneTour(zones, origin, query, filter, unit) {
  const count = zones.length;
  const fullMask = (1 << count) - 1;
  const legCache = new Map();
  const states = new Map();
  const byMask = Array.from({ length: fullMask + 1 }, () => []);

  for (let zoneIndex = 0; zoneIndex < count; zoneIndex += 1) {
    for (const candidate of zones[zoneIndex].candidates) {
      const leg = buildLocalCompleteLeg(query, filter, origin, '__origin__', candidate, unit, legCache);
      if (!leg) continue;
      const mask = 1 << zoneIndex;
      const key = `${mask}:${zoneIndex}:${candidate.id}`;
      const state = {
        key, mask, zoneIndex, candidate,
        cost: leg.objectiveCost,
        distanceMeters: leg.lengthMeters,
        previousKey: null,
        leg,
      };
      states.set(key, state);
      byMask[mask].push(state);
    }
  }

  for (let mask = 1; mask <= fullMask; mask += 1) {
    const currentStates = byMask[mask];
    for (let stateIndex = 0; stateIndex < currentStates.length; stateIndex += 1) {
      const state = currentStates[stateIndex];
      for (let nextZoneIndex = 0; nextZoneIndex < count; nextZoneIndex += 1) {
        const bit = 1 << nextZoneIndex;
        if (mask & bit) continue;
        const zone = zones[nextZoneIndex];
        for (const candidate of zone.candidates) {
          const leg = buildLocalCompleteLeg(
            query,
            filter,
            state.candidate.point,
            state.candidate.id,
            candidate,
            unit,
            legCache,
          );
          if (!leg) continue;
          const nextMask = mask | bit;
          const key = `${nextMask}:${nextZoneIndex}:${candidate.id}`;
          const cost = state.cost + leg.objectiveCost;
          const existing = states.get(key);
          if (existing && existing.cost <= cost + 1e-9) continue;
          const nextState = {
            key, mask: nextMask, zoneIndex: nextZoneIndex, candidate,
            cost,
            distanceMeters: state.distanceMeters + leg.lengthMeters,
            previousKey: state.key,
            leg,
          };
          states.set(key, nextState);
          if (!existing) byMask[nextMask].push(nextState);
          else {
            const bucket = byMask[nextMask];
            const existingIndex = bucket.findIndex((entry) => entry.key === key);
            if (existingIndex >= 0) bucket[existingIndex] = nextState;
          }
        }
      }
    }
  }

  const finals = byMask[fullMask];
  if (!finals.length) {
    const bestPartial = [...states.values()].sort((a, b) => (
      b.mask.toString(2).replace(/0/g, '').length - a.mask.toString(2).replace(/0/g, '').length
      || a.cost - b.cost
    ))[0];
    const visitedMask = bestPartial?.mask || 0;
    return {
      ok: false,
      code: 'LOCAL_INCOMPLETE_HOME_ROUTE',
      error: 'A continuous NavMesh route could not reach every navigation zone. No zone was skipped or teleported into.',
      unreachableAreas: zones.filter((zone, index) => !(visitedMask & (1 << index))).map((zone) => zone.id),
    };
  }

  finals.sort((a, b) => a.cost - b.cost || a.key.localeCompare(b.key));
  const ordered = [];
  let cursor = finals[0];
  while (cursor) {
    ordered.push(cursor);
    cursor = cursor.previousKey ? states.get(cursor.previousKey) : null;
  }
  ordered.reverse();

  const stops = ordered.map((state, index) => {
    const zone = zones[state.zoneIndex];
    return {
      index,
      areaId: zone.id,
      label: zone.label,
      point: state.candidate.point,
      role: state.candidate.role,
      hotspotId: state.candidate.id,
      clearanceMeters: state.candidate.clearanceMeters,
      route: state.leg.points,
      routeLengthMeters: Number(state.leg.lengthMeters.toFixed(3)),
    };
  });

  return {
    ok: true,
    stops,
    totalDistanceMeters: Number(stops.reduce((sum, stop) => sum + stop.routeLengthMeters, 0).toFixed(3)),
  };
}

/** Resolve the expected tour zones from areas or legacy area-tagged hotspots. */
export function getHomeTourExpectedAreas(areas, hotspots = []) {
  return normalizeHomeTourAreas(areas, hotspots);
}

/**
 * Verifies that a backend route covers the same navigation zones loaded by the
 * browser. This rejects old cached one-room routes before playback begins.
 */
export function isHomeTourRouteComplete(route, expectedAreas, minClearanceMeters = HOME_TOUR_MIN_CLEARANCE_METERS) {
  const areas = normalizeHomeTourAreas(expectedAreas, []);
  if (!areas.length || !route || Number(route.schemaVersion) !== 2
    || !Array.isArray(route.stops) || route.stops.length !== areas.length) return false;
  if (route.plannerVersion !== HOME_TOUR_PLANNER_VERSION || route.routeContract !== HOME_TOUR_ROUTE_CONTRACT) return false;
  if (Number(route.areaCount) !== areas.length || !homeTourPoint(route.origin)) return false;
  const unit = Number(route.metersPerUnit);
  if (!Number.isFinite(unit) || unit <= 0) return false;

  const expectedIds = new Set(areas.map((area) => area.id));
  const seen = new Set();
  let previousStop = null;
  for (const stop of route.stops) {
    const stopId = String(stop?.areaId || '');
    const point = homeTourPoint(stop?.point);
    const path = Array.isArray(stop?.route) ? stop.route.map(homeTourPoint) : [];
    const clearance = Number(stop?.clearanceMeters);
    if (!stopId || !expectedIds.has(stopId) || seen.has(stopId) || !point
      || !Number.isFinite(clearance) || clearance < minClearanceMeters
      || !path.length || path.some((entry) => !entry)) return false;

    const requiredStart = previousStop?.point || homeTourPoint(route.origin);
    if (homeTourDistance3D(path[0], requiredStart) > 0.24 * unit) return false;
    if (homeTourDistanceXZ(path[path.length - 1], point) > 0.22 * unit
      || Math.abs(path[path.length - 1].y - point.y) > 0.18 * unit) return false;
    seen.add(stopId);
    previousStop = { point };
  }
  return seen.size === expectedIds.size && [...expectedIds].every((id) => seen.has(id));
}

/**
 * Emergency route planner used only when the Home Tour API is unavailable or
 * returns a stale/incomplete itinerary. It follows the same complete-path,
 * measured-clearance and exact-zone-coverage contract as the backend planner.
 */
export function buildLocalHomeTourRoute({
  areas,
  hotspots,
  origin,
  metersPerUnit = 1,
  query,
  filter,
}) {
  const unit = Number(metersPerUnit);
  const start = homeTourPoint(origin);
  if (!start || !Number.isFinite(unit) || unit <= 0 || !query?.findClosestPoint || !query?.computePath) {
    return { ok: false, code: 'INVALID_LOCAL_ROUTE_INPUT', error: 'The walkthrough navigation data is not ready.' };
  }

  const normalizedAreas = normalizeHomeTourAreas(areas, hotspots);
  if (!normalizedAreas.length) {
    return { ok: false, code: 'NO_LOCAL_ROUTE_AREAS', error: 'No compiler-authored navigation zones are available.' };
  }
  if (normalizedAreas.length > 10) {
    return { ok: false, code: 'TOO_MANY_LOCAL_ROUTE_AREAS', error: 'Home Tour currently supports up to 10 curated navigation zones per walkthrough.' };
  }

  let snapped;
  try {
    snapped = query.findClosestPoint(start, {
      halfExtents: { x: 0.65 * unit, y: 1.2 * unit, z: 0.65 * unit },
      filter,
    });
  } catch {
    snapped = null;
  }
  const snappedOrigin = snapped?.success ? homeTourPoint(snapped.point) : null;
  if (!snappedOrigin || homeTourDistance3D(start, snappedOrigin) > 0.60 * unit) {
    return {
      ok: false,
      code: 'LOCAL_START_NOT_WALKABLE',
      error: 'The current camera position cannot be connected safely to the walkable floor.',
    };
  }

  const zones = [];
  for (const area of normalizedAreas) {
    const candidates = buildLocalCandidates(area, hotspots, query, filter, unit);
    if (!candidates.length) {
      return {
        ok: false,
        code: 'LOCAL_AREA_HAS_NO_VIEWPOINT',
        error: `No measured camera viewpoint with at least ${HOME_TOUR_MIN_CLEARANCE_METERS.toFixed(2)} m clearance was found for ${area.label}.`,
        unreachableAreas: [area.id],
      };
    }
    zones.push({ ...area, candidates });
  }

  const optimized = optimizeLocalZoneTour(zones, snappedOrigin, query, filter, unit);
  if (!optimized.ok) return optimized;
  const route = {
    schemaVersion: 2,
    plannerVersion: HOME_TOUR_PLANNER_VERSION,
    routeContract: HOME_TOUR_ROUTE_CONTRACT,
    source: 'local-loaded-navmesh-optimized-zones',
    origin: snappedOrigin,
    totalDistanceMeters: optimized.totalDistanceMeters,
    areaCount: optimized.stops.length,
    waypointCount: optimized.stops.reduce((sum, stop) => sum + stop.route.length, 0),
    metersPerUnit: unit,
    stops: optimized.stops,
  };
  if (!isHomeTourRouteComplete(route, normalizedAreas)) {
    return {
      ok: false,
      code: 'LOCAL_INCOMPLETE_ROUTE_CONTRACT',
      error: 'The local route did not cover every required navigation zone with a continuous validated path.',
    };
  }
  return { ok: true, route };
}
