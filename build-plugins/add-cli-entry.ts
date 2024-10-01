import { chmod } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'rollup';

/**
 * @description 用于构建命令行相关代码
 * 这是rollup 程序执行的第一步，负责解析传递给 rollup 的参数
 * @author justinhone <justinhonejiang@gmail.com>
 * @date 2024-10-01 10:15
 */
const CLI_CHUNK = 'bin/rollup';

export default function addCliEntry(): Plugin {
	return {
		buildStart() {
			this.emitFile({
				fileName: CLI_CHUNK,
				id: 'cli/cli.ts',
				preserveSignature: false,
				type: 'chunk'
			});
		},
		name: 'add-cli-entry',
		writeBundle({ dir }) {
			return chmod(path.resolve(dir!, CLI_CHUNK), '755');
		}
	};
}
