/**
 * Live2D render loop for the widget's one fixed model, Mark-kun (owner: A4, ADR-050). Our own code
 * (MIT) calling the Cubism Web Framework through ./framework. Loaded with import() only after Core
 * is present (see load.ts). Mark is shown unmodified; we only drive his standard parameters.
 */
import { mouthToParam } from "../mouth";
import {
  BreathParameterData,
  CubismBreath,
  CubismEyeBlink,
  CubismFramework,
  CubismMatrix44,
  CubismModelSettingJson,
  CubismShaderManager_WebGL,
  CubismUserModel,
  LogLevel,
  Option,
  type CubismIdHandle,
  type CubismModel,
  type CubismMotion,
} from "./framework";
import { fetchAsset, Live2DLoadError, MODEL_DIR, MODEL_FILE, prefetchShaders, SHADER_PATH, type Live2DFrame, type Live2DHandle } from "./load";

const PRIORITY_IDLE = 1;
const ZOOM = 1.45;

/** Dev-only step timings (`[live2d] 12ms moc`), to see where a slow or stuck load spends its time. */
function stepLogger() {
  const t0 = performance.now();
  return (step: string) => {
    if (process.env.NODE_ENV !== "production") console.debug(`[live2d] ${Math.round(performance.now() - t0)}ms ${step}`);
  };
}

function ensureFramework() {
  if (CubismFramework.isStarted()) return;
  const option = new Option();
  option.logFunction = (m: string) => {
    if (process.env.NODE_ENV !== "production") console.debug(`[live2d] ${m}`);
  };
  option.loggingLevel = LogLevel.LogLevel_Warning;
  CubismFramework.startUp(option);
  CubismFramework.initialize();
}

/** Exposes the protected motion manager and physics of the Framework's user model. */
class MarkModel extends CubismUserModel {
  motions: CubismMotion[] = [];
  update(dt: number) {
    const model = this.getModel();
    model.loadParameters();
    if (this._motionManager.isFinished()) {
      const next = this.motions[Math.floor(Math.random() * this.motions.length)];
      if (next) this._motionManager.startMotionPriority(next, false, PRIORITY_IDLE);
    } else {
      this._motionManager.updateMotion(model, dt);
    }
    model.saveParameters();
    return model;
  }
  physics(model: CubismModel, dt: number) {
    this._physics?.evaluate(model, dt);
  }
}

/** Downloads and decodes a texture (off the main thread where createImageBitmap exists), premultiplied. */
async function decodeTexture(url: string, signal: AbortSignal): Promise<TexImageSource> {
  const bytes = await fetchAsset(url, signal);
  const blob = new Blob([bytes], { type: "image/png" });
  try {
    if (typeof createImageBitmap === "function") return await createImageBitmap(blob, { premultiplyAlpha: "premultiply" });
  } catch {
    /* fall through to <img> */
  }
  const img = new Image();
  img.src = URL.createObjectURL(blob);
  try {
    await img.decode();
  } catch {
    throw new Live2DLoadError("model", `${url}: texture could not be decoded`);
  } finally {
    URL.revokeObjectURL(img.src);
  }
  return img;
}

function uploadTexture(gl: WebGL2RenderingContext, source: TexImageSource): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Live2DLoadError("error", "createTexture failed");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  // An ImageBitmap is already premultiplied (and ignores this flag); an <img> is premultiplied here.
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.bindTexture(gl.TEXTURE_2D, null);
  if ("close" in source) source.close();
  return tex;
}

/** Eases a value toward a target (state overlays: head tilt, gaze, brows). */
const ease = (cur: number, target: number, dt: number, tau = 0.25) => cur + (target - cur) * (1 - Math.exp(-dt / tau));

export async function startLive2D(canvas: HTMLCanvasElement, frame: () => Live2DFrame, signal: AbortSignal): Promise<Live2DHandle> {
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: true });
  if (!gl) throw new Live2DLoadError("no-webgl", "WebGL 2 is unavailable");
  const step = stepLogger();
  ensureFramework();
  step("framework started");

  // The shaders are fetched by the renderer and only logged on failure; check one up front so a
  // missing copy shows the SVG fallback instead of an empty launcher.
  const [, settingBuf] = await Promise.all([prefetchShaders(signal), fetchAsset(MODEL_DIR + MODEL_FILE, signal)]);
  const setting = new CubismModelSettingJson(settingBuf, settingBuf.byteLength);
  step("model3.json");
  const mark = new MarkModel();
  const textures: WebGLTexture[] = [];
  let raf = 0;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    for (const m of mark.motions) m.release();
    mark.release();
    setting.release();
    for (const t of textures) gl.deleteTexture(t);
    // Never lose the context while the Framework is still compiling shaders for it: its pending
    // registerShader would run on a dead context ("getAttribLocation ... not of type WebGLProgram").
    const lose = () => gl.getExtension("WEBGL_lose_context")?.loseContext();
    const shader = CubismShaderManager_WebGL.getInstance().getShader(gl);
    if (!shader?._isShaderLoading) return lose();
    const wait = setInterval(() => {
      if (!shader._isShaderLoading) {
        clearInterval(wait);
        lose();
      }
    }, 100);
  };

  try {
    // Everything after model3.json is fetched (and the texture decoded) in parallel.
    const motionNames = Array.from({ length: setting.getMotionCount("Idle") }, (_, i) => setting.getMotionFileName("Idle", i));
    const physicsFile = setting.getPhysicsFileName();
    const [moc, physics, motionBufs, images] = await Promise.all([
      fetchAsset(MODEL_DIR + setting.getModelFileName(), signal),
      physicsFile ? fetchAsset(MODEL_DIR + physicsFile, signal) : null,
      Promise.all(motionNames.map((n) => fetchAsset(MODEL_DIR + n, signal))),
      Promise.all(Array.from({ length: setting.getTextureCount() }, (_, i) => decodeTexture(MODEL_DIR + setting.getTextureFileName(i), signal))),
    ]);
    step("assets fetched + texture decoded");

    mark.loadModel(moc);
    if (!mark.getModel()) throw new Live2DLoadError("model", "Mark.moc3 could not be read by this Core");
    if (physics) mark.loadPhysics(physics, physics.byteLength);
    const ids = CubismFramework.getIdManager();
    const blinkIds: CubismIdHandle[] = [];
    for (let i = 0; i < setting.getEyeBlinkParameterCount(); i++) blinkIds.push(setting.getEyeBlinkParameterId(i));
    motionBufs.forEach((buf, i) => {
      const motion = mark.loadMotion(buf, buf.byteLength, motionNames[i]);
      if (!motion) return;
      motion.setEffectIds(blinkIds, []);
      mark.motions.push(motion);
    });
    step(`moc3, physics, ${mark.motions.length} motions`);

    mark.createRenderer(canvas.width, canvas.height);
    const renderer = mark.getRenderer();
    renderer.startUp(gl);
    renderer.loadShaders(SHADER_PATH);
    renderer.setIsPremultipliedAlpha(true);
    images.forEach((img, i) => {
      const tex = uploadTexture(gl, img);
      textures.push(tex);
      renderer.bindTexture(i, tex);
    });
    step("renderer + textures");
    if (signal.aborted) throw signal.reason;

    // Fit the figure: the projection keeps square pixels. Mark's canvas has wide empty margins, so it is
    // scaled past the limiting side (ZOOM) while his raised arms and hair still stay inside the launcher.
    const model = mark.getModel();
    const aspect = canvas.width / canvas.height;
    const projection = new CubismMatrix44();
    projection.scale(1 / aspect, 1);
    const modelAspect = model.getCanvasWidth() / model.getCanvasHeight();
    const matrix = mark.getModelMatrix();
    if (modelAspect > aspect) matrix.setWidth(2 * aspect * ZOOM);
    else matrix.setHeight(2 * ZOOM);
    // No setCenterPosition: Cubism vertices are already centred on the canvas origin, and the
    // Framework's centerX/centerY assume a corner origin (they shifted Mark half a canvas down-left).

    const eyeBlink = CubismEyeBlink.create(setting);
    const breath = CubismBreath.create();
    const P = (id: string) => ids.getId(id);
    breath.setParameters([
      new BreathParameterData(P("ParamAngleX"), 0, 8, 6.5345, 0.5),
      new BreathParameterData(P("ParamAngleY"), 0, 4, 3.5345, 0.5),
      new BreathParameterData(P("ParamBodyAngleX"), 0, 3, 15.5345, 0.5),
      new BreathParameterData(P("ParamBreath"), 0.5, 0.5, 3.2345, 1),
    ]);
    const mouthId = P("ParamMouthOpenY");
    const eyeBallY = P("ParamEyeBallY");
    const angleY = P("ParamAngleY");
    const angleZ = P("ParamAngleZ");
    const browL = P("ParamBrowLY");
    const browR = P("ParamBrowRY");
    const pose = { gaze: 0, nod: 0, tilt: 0, brow: 0 };

    // Resolve only once Mark has really been drawn (shaders fetched and compiled), so the canvas
    // never replaces the SVG placeholder while it is still blank.
    const shaders = CubismShaderManager_WebGL.getInstance().getShader(gl);
    let drawn = false;
    let onDrawn!: () => void;
    let onAbort!: (reason: unknown) => void;
    const firstFrame = new Promise<void>((resolve, reject) => {
      onDrawn = resolve;
      onAbort = reject;
    });
    signal.addEventListener("abort", () => onAbort(signal.reason), { once: true });

    let last = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (document.hidden) {
        last = 0;
        return;
      }
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
      last = now;
      const f = frame();
      const m = mark.update(dt);
      eyeBlink.updateParameters(m, dt);
      breath.updateParameters(m, dt);
      // State overlays on top of the idle motion.
      pose.gaze = ease(pose.gaze, f.state === "thinking" ? 0.8 : 0, dt);
      pose.nod = ease(pose.nod, f.state === "thinking" ? 12 : 0, dt);
      pose.tilt = ease(pose.tilt, f.state === "listening" ? 9 : 0, dt);
      pose.brow = ease(pose.brow, f.state === "listening" ? 0.6 : 0, dt);
      m.addParameterValueById(eyeBallY, pose.gaze);
      m.addParameterValueById(angleY, pose.nod);
      m.addParameterValueById(angleZ, pose.tilt);
      m.addParameterValueById(browL, pose.brow);
      m.addParameterValueById(browR, pose.brow);
      m.setParameterValueById(mouthId, mouthToParam(f.mouth));
      mark.physics(m, dt);
      m.update();

      if (!shaders._isShaderLoaded) {
        // generateShaders() started synchronously in loadShaders() above, so "not loading and not
        // loaded" means the Framework's shader setup failed: fall back to the SVG mascot.
        if (!shaders._isShaderLoading) onAbort(new Live2DLoadError("error", "Live2D shaders failed to compile or link"));
        return; // still fetching/compiling
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      const mvp = new CubismMatrix44();
      mvp.multiplyByMatrix(projection);
      mvp.multiplyByMatrix(matrix);
      renderer.setMvpMatrix(mvp);
      renderer.setRenderState(null, [0, 0, canvas.width, canvas.height]);
      renderer.drawModel(SHADER_PATH);
      if (!drawn) {
        drawn = true;
        step("first frame");
        onDrawn();
      }
    };
    raf = requestAnimationFrame(tick);
    signal.addEventListener("abort", dispose, { once: true });
    await firstFrame;
    return { dispose };
  } catch (err) {
    dispose();
    throw err;
  }
}
