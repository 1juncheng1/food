// ────────────────────────────────────────────────────────────
// 视界图片资源注册表（唯一来源）
//
// 约定：
//   所有视觉素材统一放在 public/images/vision/ 下，
//   文件名由「页面域 + 槽位类型」构成，四类槽位固定：
//
//     hero-image       主视觉：电影级人物 / 现实场景 / 抽象科技主体
//     feature-image    功能视觉：说明某个具体能力的画面
//     editorial-image  编辑视觉：用于观点、文章、社区等排版场景
//     illustration     插画：抽象但有意义的概念图形
//
// 真实素材放进去即自动生效，不需要改任何组件代码；
// 文件不存在时自动降级为带标注的占位区，不出现裂图。
// ────────────────────────────────────────────────────────────

export const VISION_IMAGE_DIR = '/images/vision'

export type VisionSlotKind =
  | 'hero-image'
  | 'feature-image'
  | 'editorial-image'
  | 'illustration'

/** 槽位在占位态显示的英文标识，方便后续按名字替换素材 */
export const VISION_SLOT_MARK: Record<VisionSlotKind, string> = {
  'hero-image': 'HERO IMAGE',
  'feature-image': 'FEATURE IMAGE',
  'editorial-image': 'EDITORIAL IMAGE',
  illustration: 'ILLUSTRATION',
}

/** 占位态的一句说明，告诉后续接手的人这里该放什么 */
export const VISION_SLOT_NOTE: Record<VisionSlotKind, string> = {
  'hero-image': '主视觉位 · 后续替换为电影级人物或现实场景摄影',
  'feature-image': '功能视觉位 · 后续替换为说明该能力的画面',
  'editorial-image': '编辑视觉位 · 后续替换为观点 / 文章配图',
  illustration: '插画位 · 后续替换为抽象概念图形',
}

/**
 * 拼出图片路径。
 * @param scope 页面域，如 home / generate / knowledge / agent
 * @param name  素材名，如 opening / path-01；多张时自行编号
 */
export function visionImage(
  scope: string,
  kind: VisionSlotKind,
  name?: string,
  ext = 'png',
): string {
  return `${VISION_IMAGE_DIR}/${scope}-${name ?? kind}-${kind}.${ext}`
}

/** 首页当前在用的素材清单，改这里即可换图 */
export const HOME_IMAGES = {
  hero: visionImage('home', 'hero-image', 'opening'),
  // 成长路径三连图：数组顺序即 GROWTH_PATH 的卡片顺序，别四处手写 png 路径。
  // 三张素材比例不同，各自原始宽高写在 lib/home-content.ts 的 GROWTH_PATH 里，
  // 换图时两处的 width / height 必须同步改，否则会静默恢复裁切。
  path: [
    visionImage('home', 'feature-image', 'path-01', 'jpg'),
    visionImage('home', 'feature-image', 'path-02', 'jpg'),
    visionImage('home', 'feature-image', 'path-03', 'jpg'),
  ],
  // 核心能力插画：单张，原始宽高跟素材写在一起，槽位比例由它算出来
  // （见 components/home/capability-section.tsx）。改图和改尺寸必须一起来。
  capability: {
    src: visionImage('home', 'illustration', 'capability', 'jpg'),
    width: 735,
    height: 985,
  },
  // 灵感社区特写：同上，比例 1080/607 比原先写死的 16/10 更宽一点，
  // 保持原比例才不会被左右各切掉一截（见 components/home/community-preview-section.tsx）。
  community: {
    src: visionImage('home', 'editorial-image', 'community', 'jpg'),
    width: 1080,
    height: 607,
  },
} as const

/**
 * 首页首屏主视觉视频（720×900，正好 4:5）。
 * 放在 public 根目录，不走 images/vision —— 那条链路是给图片素材用的。
 */
export const HOME_HERO_VIDEO = '/vision.mp4'

/**
 * 生成作品页（/generate）素材清单。
 *
 * 这两处不走 visionImage() 的 `${scope}-${name}-${kind}` 拼法：
 * 页面上原本就把占位路径写成了 `creation-hero` / `creation-illustration`，
 * 沿用它能保证「占位框上显示什么路径，素材就落在这个路径」，不用记额外规则。
 *
 * hero 已是真实素材（862×1080 黑底字标），换图时注意保持原始比例；
 * illustration 仍是占位，拿到素材后照旧丢进同一目录即可。
 */
export const CREATION_IMAGES = {
  hero: `${VISION_IMAGE_DIR}/creation-hero.jpeg`,
  illustration: `${VISION_IMAGE_DIR}/creation-illustration.png`,
} as const
