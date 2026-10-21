export type FileShareDom = {
  shadow: ShadowRoot;
  mount: HTMLElement;
  portal: HTMLElement;
};

const key = Symbol.for("pexserver.fileshare.dom.v1");
const dom = (globalThis as any)[key] as FileShareDom | undefined;
delete (globalThis as any)[key];

export function fileShareDom(): FileShareDom {
  if (!dom) throw new Error("FileShare DOM is not initialized");
  return dom;
}

export const appMount = () => fileShareDom().mount;
export const portalMount = () => fileShareDom().portal;
export const appActiveElement = () =>
  fileShareDom().shadow.activeElement as HTMLElement | null;
export const appQuery = <T extends Element>(selector: string) =>
  fileShareDom().shadow.querySelector<T>(selector);
export const appElementById = <T extends HTMLElement>(id: string) =>
  fileShareDom().shadow.querySelector<T>(`#${CSS.escape(id)}`);
