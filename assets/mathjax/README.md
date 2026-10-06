# MathJax v3（tex-svg-full）本地资源

本目录存放 MathJax v3 的完整 TeX → SVG 浏览器端打包脚本，供本项目在**离线**环境下以本地经典脚本（`<script src>`）方式加载，用于渲染数学公式（如笔记中的 LaTeX 公式）。

## 文件

| 文件 | 说明 | 大小 | SHA-256 |
| --- | --- | --- | --- |
| `tex-svg-full.js` | MathJax v3.2.2 完整 TeX 输入 + SVG 输出组合包（minified，非 ES module） | 2,275,113 字节 | `A4354FF94FD868AEA0CC6EAAA79A57FDA0588646FC46EE3700A349EE0A11CBE6` |
| `LICENSE` | MathJax 使用的 Apache License 2.0 全文 | — | — |

- **版本**：3.2.2（MathJax v3 的最后一个稳定版本）
- **来源 URL**：`https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-svg-full.js`
  （与 npm 官方包 `mathjax@3.2.2` 中 `package/es5/tex-svg-full.js` 逐字节一致）
- **上游项目**：<https://github.com/mathjax/MathJax-src>

## 内置的 TeX 扩展

该 bundle 打包了 MathJax v3.2.2 提供的**全部** TeX 扩展，主要包括：

- **base、ams、boldsymbol、newcommand、noundefined**（基础与 LaTeX 常用宏）
- **mhchem**（`\ce` 化学式；内含 mhchemParser 4.1.1，© Martin Hensel，Apache-2.0）
- **physics**（物理宏，默认不启用，需在 `tex.packages` 中加入或使用 `\require{physics}`）
- **color**（`\textcolor`、`\colorbox`、`\fcolorbox` 均由此扩展提供）、**colortbl**、**colorv2**
- **bbox、enclose、empheq、mathtools、cancel、cases、centernot、amscd、upgreek、gensymb、extpfeil、braket、bussproofs、action、html、textcomp、textmacros、unicode、verb、tagformat、configmacros、noerrors**
- **require / autoload**（运行时按需加载/自动加载扩展；`require` 默认启用，`autoload` 已预加载）
- **setoptions**（配合 `\require` 使用，已预加载）

> 说明：`siunitx` 并非 MathJax v3（乃至 v4）提供的扩展，本 bundle 中不存在；单位排版可使用 physics 的 `\qty{数值}{单位}` 等宏。默认启用的包为 `base, action, ams, amscd, bbox, boldsymbol, braket, bussproofs, cancel, cases, centernot, color, colortbl, empheq, enclose, extpfeil, gensymb, html, mathtools, mhchem, newcommand, noerrors, noundefined, upgreek, unicode, verb, configmacros, tagformat, textcomp, textmacros` 加上 `require`。

## 许可证

Apache License 2.0，© MathJax Consortium。
bundle 内另含 mhchemParser（© 2015–2021 Martin Hensel），同样以 Apache-2.0 授权。
**分发/使用本文件时必须保留 `LICENSE` 文件。**

## 用法（离线、经典脚本）

```html
<script>
window.MathJax = {
  tex: { inlineMath: [['$', '$']], displayMath: [['$$', '$$']] },
  svg: { fontCache: 'global' }
};
</script>
<script src="assets/mathjax/tex-svg-full.js"></script>
```

- 以经典脚本（非 `type="module"`）方式加载，无需网络，不请求任何 CDN。
- 校验完整性时可执行：`Get-FileHash -Algorithm SHA256 assets/mathjax/tex-svg-full.js`，应得到上表哈希。
