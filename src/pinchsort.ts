import {
  BoxGeometry,
  CanvasTexture,
  CylinderGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  DistanceGrabbable,
  MovementMode,
  PlaneGeometry,
  RayInteractable,
  SphereGeometry,
  Plane,
  Raycaster,
  Vector2,
  Vector3,
  World,
  createSystem,
} from '@iwsdk/core';

const COLORS = [0xff4d4d, 0x4dd2ff, 0xffd84d];
const PAD_X = [-0.3, 0, 0.3];
const PAD_Y = 0.81;
const PAD_Z = -0.7;
const PAD_RADIUS = 0.15;
const PAD_VISUAL = 0.13;
const DROP_HEIGHT = 1.2;
const START_Y = 1.05;
const START_Z = -0.4;
const LEVEL_SIZES = [6, 9, 12, 15];
const MAX_ORBS = 15;
const DEBUG = false;

interface Orb {
  mesh: Mesh;
  colorIndex: number;
  sorted: boolean;
  active: boolean;
  locked: boolean;
  still: number;
  last: Vector3;
}

const orbs: Orb[] = [];
const pads: Mesh[] = [];
const padPulse = [0, 0, 0];
let level = 0;
let mistakes = 0;
let startedAt = 0;
let finishedAt = 0;
let nextLevelAt = 0;
let lastHud = 0;
let lastNow = 0;
let hudCanvas: HTMLCanvasElement | null = null;
let hudCtx: CanvasRenderingContext2D | null = null;
let hudTexture: CanvasTexture | null = null;

function shuffle(items: number[]): number[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function drawHud(lines: string[], accent: string): void {
  if (!hudCtx || !hudCanvas || !hudTexture) return;
  const w = hudCanvas.width;
  const h = hudCanvas.height;
  hudCtx.clearRect(0, 0, w, h);
  hudCtx.fillStyle = 'rgba(20,24,34,0.88)';
  hudCtx.fillRect(0, 0, w, h);
  hudCtx.fillStyle = accent;
  hudCtx.fillRect(0, 0, w, 14);
  hudCtx.fillStyle = '#ffffff';
  hudCtx.textAlign = 'center';
  hudCtx.font = 'bold 72px sans-serif';
  hudCtx.fillText(lines[0], w / 2, 120);
  hudCtx.font = '52px sans-serif';
  lines.slice(1).forEach((text, i) => hudCtx!.fillText(text, w / 2, 210 + i * 70));
  hudTexture.needsUpdate = true;
}

function startLevel(n: number): void {
  level = n;
  const count = LEVEL_SIZES[n];
  mistakes = 0;
  finishedAt = 0;
  startedAt = performance.now();
  const order = shuffle(Array.from({ length: count }, (_, i) => i % 3));
  const perRow = count > 9 ? Math.ceil(count / 2) : count;
  orbs.forEach((orb, i) => {
    orb.sorted = false;
    orb.locked = false;
    orb.still = 0;
    orb.active = i < count;
    if (!orb.active) {
      orb.mesh.visible = false;
      orb.mesh.position.set(0, -5, 0);
      return;
    }
    orb.colorIndex = order[i];
    const mat = orb.mesh.material as MeshStandardMaterial;
    mat.color.setHex(COLORS[order[i]]);
    mat.emissive.setHex(COLORS[order[i]]);
    mat.emissiveIntensity = 0.35;
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const rowCount = row === 0 ? perRow : count - perRow;
    const x = (col - (rowCount - 1) / 2) * 0.1;
    orb.mesh.visible = true;
    orb.mesh.position.set(x, START_Y + row * 0.1, START_Z);
    orb.last.set(x, START_Y + row * 0.1, START_Z);
  });
}

export function setupPinchSort(world: World): void {
  // Table
  const table = new Mesh(
    new BoxGeometry(1.1, 0.04, 0.7),
    new MeshStandardMaterial({ color: 0x3a3f4b }),
  );
  table.position.set(0, 0.78, -0.62);
  world.createTransformEntity(table);

  // Colored pads
  COLORS.forEach((color, i) => {
    const pad = new Mesh(
      new CylinderGeometry(PAD_VISUAL, PAD_VISUAL, 0.02, 32),
      new MeshStandardMaterial({ color }),
    );
    pad.position.set(PAD_X[i], PAD_Y, PAD_Z);
    world.createTransformEntity(pad);
    pads.push(pad);
  });

  // Score panel
  hudCanvas = document.createElement('canvas');
  hudCanvas.width = 1024;
  hudCanvas.height = 384;
  hudCtx = hudCanvas.getContext('2d');
  hudTexture = new CanvasTexture(hudCanvas);
  const hud = new Mesh(
    new PlaneGeometry(0.8, 0.3),
    new MeshBasicMaterial({ map: hudTexture, transparent: true }),
  );
  hud.position.set(0, 1.3, -0.8);
  world.createTransformEntity(hud);

  // Orbs (all created once, shown or hidden per level)
  for (let i = 0; i < MAX_ORBS; i++) {
    const mesh = new Mesh(
      new SphereGeometry(0.035, 24, 24),
      new MeshStandardMaterial({ color: 0xffffff }),
    );
    const entity = world.createTransformEntity(mesh);
    entity.addComponent(RayInteractable);
        entity.addComponent(DistanceGrabbable, {
      movementMode: MovementMode.MoveFromTarget,
    });
    orbs.push({
      mesh,
      colorIndex: 0,
      sorted: false,
      active: false,
      locked: false,
      still: 0,
      last: new Vector3(),
    });
  }

  lastNow = performance.now();
  startLevel(0);
  enableMouseDrag2(world);
  enableDropCheck(world);
}

export class PinchSortSystem extends createSystem({}) {
  update(): void {
    const now = performance.now();
    const dt = now - lastNow;
    lastNow = now;

    padPulse.forEach((value, i) => {
      padPulse[i] = value * 0.9;
      pads[i]?.scale.setScalar(1 + 0.12 * padPulse[i]);
    });

    if (finishedAt > 0) {
      if (now >= nextLevelAt) startLevel((level + 1) % LEVEL_SIZES.length);
      return;
    }

    let remaining = 0;
    let dbg = '';
    let best = 99;
    for (const orb of orbs) {
      if (!orb.active || orb.sorted) continue;
      const p = orb.mesh.position;
      for (let k = 0; k < 3; k++) { const d = Math.hypot(p.x - PAD_X[k], p.z - PAD_Z); if (d < best) { best = d; dbg = `x${p.x.toFixed(2)} y${p.y.toFixed(2)} z${p.z.toFixed(2)} d${d.toFixed(2)}`; } }
      let padHit = -1;
      for (let j = 0; j < 3; j++) {
        const close = Math.hypot(p.x - PAD_X[j], p.z - PAD_Z) < PAD_RADIUS;
        if (close && p.y < DROP_HEIGHT && p.y > 0.7) padHit = j;
      }
      if (padHit < 0) {
        orb.locked = false;
        orb.still = 0;
        orb.last.copy(p);
        remaining++;
        continue;
      }
      const moved = p.distanceTo(orb.last);
      orb.last.copy(p);
      orb.still = moved < 0.005 ? orb.still + dt : 0;
      if (!orb.locked && orb.still >= 250) {
        if (orb.colorIndex === padHit) {
          orb.sorted = true;
          orb.mesh.visible = false;
          orb.mesh.position.set(0, -5, 0);
          padPulse[padHit] = 1;
          continue;
        }
        mistakes++;
        orb.locked = true;
        orb.still = 0;
      }
      remaining++;
    }

    const count = LEVEL_SIZES[level];
    if (remaining === 0) {
      finishedAt = now;
      nextLevelAt = now + 5000;
      const secs = Math.round((now - startedAt) / 1000);
      const last = level === LEVEL_SIZES.length - 1;
      drawHud(
        [
          'Level complete!',
          `Time ${secs}s   Mistakes ${mistakes}`,
          last ? 'You finished every level!' : 'Next level starting...',
        ],
        '#59d98e',
      );
      return;
    }
    if (now - lastHud > 200) {
      lastHud = now;
      const secs = Math.round((now - startedAt) / 1000);
      drawHud(
        [
          `Pinch Sort - Level ${level + 1}/${LEVEL_SIZES.length}`,
          `Sorted ${count - remaining} / ${count}   Mistakes ${mistakes}`,
          `Time ${secs}s${DEBUG ? "  " + dbg : ""}`,
        ],
        '#4dd2ff',
      );
    }
  }
}


function enableMouseDrag(world: World): void {
  const canvas = world.renderer.domElement;
  const raycaster = new Raycaster();
  const pointer = new Vector2();
  const plane = new Plane(new Vector3(0, 1, 0), -0.86);
  const hit = new Vector3();
  let dragging: Orb | null = null;

  const aim = (e: PointerEvent): void => {
    const r = canvas.getBoundingClientRect();
    pointer.set(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, world.camera);
  };

  canvas.addEventListener('pointerdown', (e: PointerEvent) => {
    if (world.renderer.xr.isPresenting) return;
    aim(e);
    const meshes = orbs.filter((o) => o.active && !o.sorted).map((o) => o.mesh);
    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return;
    dragging = orbs.find((o) => o.mesh === hits[0].object) ?? null;
    if (dragging) {
      dragging.still = 0;
      canvas.setPointerCapture(e.pointerId);
    }
  });

  canvas.addEventListener('pointermove', (e: PointerEvent) => {
    if (!dragging) return;
    aim(e);
    if (raycaster.ray.intersectPlane(plane, hit)) {
      dragging.mesh.position.set(hit.x, 0.86, hit.z);
    }
  });

  const release = (): void => {
    dragging = null;
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
}





function enableMouseDrag2(world: World): void {
  try {
    const w = world as any;
    const camera = w.camera;
    const canvas: HTMLCanvasElement | null =
      w.renderer?.domElement ?? (document.querySelector('canvas') as HTMLCanvasElement | null);
    if (!camera || !canvas) {
      alert('Mouse setup failed. world keys: ' + Object.keys(w).join(', '));
      return;
    }
    const raycaster = new Raycaster();
    const pointer = new Vector2();
    const plane = new Plane(new Vector3(0, 1, 0), -0.86);
    const hit = new Vector3();
    let dragging: Orb | null = null;

    const aim = (e: PointerEvent): void => {
      const r = canvas.getBoundingClientRect();
      pointer.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
    };

    window.addEventListener(
      'pointerdown',
      (e: PointerEvent) => {
        if (w.renderer?.xr?.isPresenting) return;
        aim(e);
        const meshes = orbs.filter((o) => o.active && !o.sorted).map((o) => o.mesh);
        const hits = raycaster.intersectObjects(meshes, false);
        if (hits.length === 0) return;
        dragging = orbs.find((o) => o.mesh === hits[0].object) ?? null;
        if (dragging) dragging.still = 0;
      },
      true,
    );

    window.addEventListener(
      'pointermove',
      (e: PointerEvent) => {
        if (!dragging) return;
        aim(e);
        if (raycaster.ray.intersectPlane(plane, hit)) {
          dragging.mesh.position.set(hit.x, 0.86, hit.z);
        }
      },
      true,
    );

    const release = (): void => {
      dragging = null;
    };
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
  } catch (err) {
    alert('Mouse setup error: ' + String(err));
  }
}


function dropOrb(orb: Orb): void {
  if (!orb.active || orb.sorted || finishedAt > 0) return;
  const p = orb.mesh.position;
  for (let j = 0; j < 3; j++) {
    const close = Math.hypot(p.x - PAD_X[j], p.z - PAD_Z) < PAD_RADIUS;
    if (close && p.y < DROP_HEIGHT && p.y > 0.7) {
      if (orb.colorIndex === j) {
        orb.sorted = true;
        orb.mesh.visible = false;
        orb.mesh.position.set(0, -5, 0);
        padPulse[j] = 1;
      } else {
        mistakes++;
        orb.locked = true;
      }
      return;
    }
  }
}

function enableDropCheck(world: World): void {
  try {
    const w = world as any;
    const camera = w.camera;
    const canvas: HTMLCanvasElement | null =
      w.renderer?.domElement ?? (document.querySelector('canvas') as HTMLCanvasElement | null);
    if (!camera || !canvas) return;
    const raycaster = new Raycaster();
    const pointer = new Vector2();
    let held: Orb | null = null;

    window.addEventListener(
      'pointerdown',
      (e: PointerEvent) => {
        const r = canvas.getBoundingClientRect();
        pointer.set(
          ((e.clientX - r.left) / r.width) * 2 - 1,
          -((e.clientY - r.top) / r.height) * 2 + 1,
        );
        raycaster.setFromCamera(pointer, camera);
        const meshes = orbs.filter((o) => o.active && !o.sorted).map((o) => o.mesh);
        const hits = raycaster.intersectObjects(meshes, false);
        held = hits.length ? (orbs.find((o) => o.mesh === hits[0].object) ?? null) : null;
      },
      true,
    );

    const drop = (): void => {
      if (held) {
        dropOrbScreen(held, camera, canvas);
        held = null;
      }
    };
    window.addEventListener('pointerup', drop, true);
    window.addEventListener('pointercancel', drop, true);
  } catch (err) {
    alert('Drop setup error: ' + String(err));
  }
}


function dropOrbScreen(orb: Orb, camera: any, canvas: HTMLCanvasElement): void {
  if (!orb.active || orb.sorted || finishedAt > 0) return;
  const rect = canvas.getBoundingClientRect();
  const toScreen = (x: number, y: number, z: number) => {
    const v = new Vector3(x, y, z).project(camera);
    return { x: (v.x * 0.5 + 0.5) * rect.width, y: (-v.y * 0.5 + 0.5) * rect.height };
  };
  const p = orb.mesh.position;
  const o = toScreen(p.x, p.y, p.z);
  let best = -1;
  let bestD = 1e9;
  for (let j = 0; j < 3; j++) {
    const pp = toScreen(PAD_X[j], PAD_Y + 0.03, PAD_Z);
    const d = Math.hypot(o.x - pp.x, o.y - pp.y);
    if (d < bestD) {
      bestD = d;
      best = j;
    }
  }
  const limit = rect.width * 0.07;
  console.log('DROP', 'orbColor', orb.colorIndex, 'nearestPad', best, 'dist', Math.round(bestD), 'limit', Math.round(limit), 'pos', p.x.toFixed(2), p.y.toFixed(2), p.z.toFixed(2));
  if (best < 0 || bestD > limit) return;
  if (orb.colorIndex === best) {
    orb.sorted = true;
    orb.mesh.visible = false;
    orb.mesh.position.set(0, -5, 0);
    padPulse[best] = 1;
  } else {
    mistakes++;
  }
}
