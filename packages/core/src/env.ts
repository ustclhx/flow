/** 新环境变量优先；空串视为未设置，再兼容同后缀的 FLOW_*。身份变量须单独按权限合并。 */
export function readRaindownEnv(
  name: `RAINDOWN_${string}`,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return env[name]?.trim() || env[name.replace(/^RAINDOWN_/, 'FLOW_')]?.trim() || undefined
}
