/**
 * Our own minimal typings (MIT) for the parts of the Cubism Web Framework that runtime.ts uses; see
 * framework.js for why the Framework's own sources are not type-checked here.
 */
export interface CubismIdHandle {
  readonly __cubismId?: never;
}

export interface CubismModel {
  getCanvasWidth(): number;
  getCanvasHeight(): number;
  getParameterValueById(id: CubismIdHandle): number;
  setParameterValueById(id: CubismIdHandle, value: number, weight?: number): void;
  addParameterValueById(id: CubismIdHandle, value: number, weight?: number): void;
  loadParameters(): void;
  saveParameters(): void;
  update(): void;
}

export declare class CubismMatrix44 {
  loadIdentity(): void;
  scale(x: number, y: number): void;
  translate(x: number, y: number): void;
  multiplyByMatrix(m: CubismMatrix44): void;
  getArray(): Float32Array;
}

export interface CubismModelMatrix extends CubismMatrix44 {
  setWidth(w: number): void;
  setHeight(h: number): void;
  setCenterPosition(x: number, y: number): void;
}

export declare enum LogLevel {
  LogLevel_Verbose = 0,
  LogLevel_Debug = 1,
  LogLevel_Info = 2,
  LogLevel_Warning = 3,
  LogLevel_Error = 4,
  LogLevel_Off = 5,
}

export declare class Option {
  logFunction: (message: string) => void;
  loggingLevel: LogLevel;
}

export declare class CubismFramework {
  static startUp(option?: Option | null): boolean;
  static initialize(memorySize?: number): void;
  static isStarted(): boolean;
  static isInitialized(): boolean;
  static getIdManager(): { getId(id: string): CubismIdHandle };
}

export declare class CubismModelSettingJson {
  constructor(buffer: ArrayBuffer, size: number);
  getModelFileName(): string;
  getTextureCount(): number;
  getTextureFileName(index: number): string;
  getPhysicsFileName(): string;
  getMotionCount(groupName: string): number;
  getMotionFileName(groupName: string, index: number): string;
  getEyeBlinkParameterCount(): number;
  getEyeBlinkParameterId(index: number): CubismIdHandle;
  release(): void;
}

export interface CubismMotion {
  setEffectIds(eyeBlinkParameterIds: CubismIdHandle[], lipSyncParameterIds: CubismIdHandle[]): void;
  release(): void;
}

export interface CubismMotionManager {
  isFinished(): boolean;
  updateMotion(model: CubismModel, deltaTimeSeconds: number): boolean;
  startMotionPriority(motion: CubismMotion, autoDelete: boolean, priority: number): number;
  stopAllMotions(): void;
}

export interface CubismPhysics {
  evaluate(model: CubismModel, deltaTimeSeconds: number): void;
}

export interface CubismRenderer_WebGL {
  startUp(gl: WebGL2RenderingContext): void;
  loadShaders(shaderPath?: string | null): void;
  bindTexture(modelTextureNo: number, glTexture: WebGLTexture): void;
  setIsPremultipliedAlpha(enable: boolean): void;
  setMvpMatrix(matrix: CubismMatrix44): void;
  setRenderState(fbo: WebGLFramebuffer | null, viewport: number[]): void;
  drawModel(shaderPath?: string | null): void;
}

export declare class CubismUserModel {
  constructor();
  loadModel(buffer: ArrayBuffer, shouldCheckMocConsistency?: boolean): void;
  loadMotion(buffer: ArrayBuffer, size: number, name: string): CubismMotion | null;
  loadPhysics(buffer: ArrayBuffer, size: number): void;
  createRenderer(width: number, height: number, maskBufferCount?: number): void;
  getRenderer(): CubismRenderer_WebGL;
  getModel(): CubismModel;
  getModelMatrix(): CubismModelMatrix;
  release(): void;
  protected _motionManager: CubismMotionManager;
  protected _physics: CubismPhysics | null;
}

export declare class CubismEyeBlink {
  static create(modelSetting?: CubismModelSettingJson | null): CubismEyeBlink;
  updateParameters(model: CubismModel, deltaTimeSeconds: number): void;
}

export declare class BreathParameterData {
  constructor(parameterId: CubismIdHandle, offset: number, peak: number, cycle: number, weight: number);
}

export declare class CubismBreath {
  static create(): CubismBreath;
  setParameters(breathParameters: BreathParameterData[]): void;
  updateParameters(model: CubismModel, deltaTimeSeconds: number): void;
}

/** The renderer fetches its shaders asynchronously; `_isShaderLoaded` turns true once they compiled. */
export declare class CubismShaderManager_WebGL {
  static getInstance(): CubismShaderManager_WebGL;
  getShader(gl: WebGL2RenderingContext): { _isShaderLoaded: boolean; _isShaderLoading: boolean };
}
