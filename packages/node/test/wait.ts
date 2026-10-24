/** 只等待可观察条件；真实时间上限用于诊断挂死，不推进被测代码的虚拟时钟。 */
export async function waitFor(pred: () => boolean, what: string) {
  const deadline = performance.now() + 2000
  while (!pred()) {
    if (performance.now() >= deadline) throw new Error(`等待超时：${what}`)
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
  }
}
