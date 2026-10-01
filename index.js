/**
 * dsh-composer-live — host half.
 *
 * Host 侧是无操作 loader entry：全部功能在浏览器端（./client），由 DSH 的
 * dsh-client-modules 通过 package.json 的 `dsh.client` 声明加载。输入框
 * markdown 实时渲染/工具栏/快捷键都是纯 DOM/CSS 层面的浏览器行为，
 * 不需要任何 host 服务或路由，也不注入任何 client 服务（零服务依赖，
 * 对官方 client API 变化免疫）。
 */

/** Host loader entry for the browser implementation exported from `./client`. */
export function apply() {}
