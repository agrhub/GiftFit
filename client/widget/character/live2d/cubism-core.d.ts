/**
 * Minimal ambient typing (our own, MIT) for the `Live2DCubismCore` global that Live2D's proprietary
 * live2dcubismcore.min.js installs. The official .d.ts ships with the Core SDK and, like Core, is
 * never committed (ADR-050). Deliberately loose: the Framework is the only caller.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
declare namespace Live2DCubismCore {
  type csmLogFunction = (message: string) => void;
  type csmParameterType = number;
  type Moc = any;
  type Model = any;
  const Moc: any;
  const Model: any;
  const Version: any;
  const Logging: any;
  const Utils: any;
  const Memory: any;
  const ColorBlendType_Normal: number;
  const ColorBlendType_AddGlow: number;
  const ColorBlendType_Add: number;
  const ColorBlendType_Darken: number;
  const ColorBlendType_Multiply: number;
  const ColorBlendType_ColorBurn: number;
  const ColorBlendType_LinearBurn: number;
  const ColorBlendType_Lighten: number;
  const ColorBlendType_Screen: number;
  const ColorBlendType_ColorDodge: number;
  const ColorBlendType_Overlay: number;
  const ColorBlendType_SoftLight: number;
  const ColorBlendType_HardLight: number;
  const ColorBlendType_LinearLight: number;
  const ColorBlendType_Hue: number;
  const ColorBlendType_Color: number;
  const ColorBlendType_AddCompatible: number;
  const ColorBlendType_MultiplyCompatible: number;
}
