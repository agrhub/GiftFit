/**
 * The only bridge from our code (MIT) into the Live2D Cubism Web Framework submodule (Live2D Open
 * Software License, vendor/CubismWebFramework, not relicensed). Plain JS on purpose: TypeScript
 * resolves `./framework` to framework.d.ts (our loose types) and never type-checks the Framework's
 * sources, which are not strict-null clean; the bundler resolves it to this file.
 *
 * Import this module only AFTER Core (window.Live2DCubismCore) has loaded: the Framework reads Core
 * constants while its modules evaluate. runtime.ts is loaded with import() for that reason.
 */
export { CubismFramework, Option, LogLevel } from "../../../../vendor/CubismWebFramework/src/live2dcubismframework";
export { CubismModelSettingJson } from "../../../../vendor/CubismWebFramework/src/cubismmodelsettingjson";
export { CubismUserModel } from "../../../../vendor/CubismWebFramework/src/model/cubismusermodel";
export { CubismMatrix44 } from "../../../../vendor/CubismWebFramework/src/math/cubismmatrix44";
export { CubismEyeBlink } from "../../../../vendor/CubismWebFramework/src/effect/cubismeyeblink";
export { CubismBreath, BreathParameterData } from "../../../../vendor/CubismWebFramework/src/effect/cubismbreath";
export { CubismShaderManager_WebGL } from "../../../../vendor/CubismWebFramework/src/rendering/cubismshader_webgl";
