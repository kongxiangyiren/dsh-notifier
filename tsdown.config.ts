import { defineConfig } from 'tsdown';

/**
 * 两套构建：
 * 1. Host 半体 `src/index.ts` → `dist/index.mjs`（node 平台，生成 .d.mts，并维护 package.json 的 exports）；
 * 2. Client 半体 `src/client.ts` → `dist/client.mjs`（浏览器平台，带 sourcemap；模块表里的 React 通过
 *    工厂参数 `require` 取得，不打包任何 Harness Client 包）。
 * 第二个配置 `clean: false`，避免清掉第一个配置刚产出的文件。
 */
export default defineConfig([
  {
    entry: ['src/index.ts'],
    platform: 'node',
    format: ['esm'],
    target: 'node20',
    outDir: 'dist',
    clean: true,
    dts: {
      tsgo: true
    },
    deps: {
      neverBundle: ['@deepseek-ai/cordis']
    },
    exports: {
      customExports: {
        './package.json': './package.json',
        './locale/*.json': './locale/*.json',
        './client': './dist/client.js'
      }
    }
  },
  {
    entry: ['src/client.ts'],
    platform: 'browser',
    format: ['esm'],
    target: 'es2022',
    outDir: 'dist',
    clean: false,
    dts: false
  }
]);
