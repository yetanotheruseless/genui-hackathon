declare module "react-katex" {
  import { ComponentType } from "react";
  type Props = { math: string; errorColor?: string };
  export const InlineMath: ComponentType<Props>;
  export const BlockMath: ComponentType<Props>;
}
