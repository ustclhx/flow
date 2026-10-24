import { readFileSync } from 'node:fs'

/**
 * 页面的静态资源（design D5：不引入前端构建链）。原样放在 `static/` 下，启动时读入内存，
 * 由 `/ui/static/*` 提供；CSP 只允许同源脚本与样式，因此页面中没有任何内联脚本或样式。
 */
const read = (name: string) => readFileSync(new URL(`./static/${name}`, import.meta.url), 'utf8')

export const APP_CSS = read('app.css')
export const APP_JS = read('app.js')
export const ICON_SVG = read('icon.svg')
