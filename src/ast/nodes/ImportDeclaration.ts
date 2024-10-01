import type MagicString from 'magic-string';
import type { NodeRenderOptions, RenderOptions } from '../../utils/renderHelpers';
import type ImportAttribute from './ImportAttribute';
import type ImportDefaultSpecifier from './ImportDefaultSpecifier';
import type ImportNamespaceSpecifier from './ImportNamespaceSpecifier';
import type ImportSpecifier from './ImportSpecifier';
import type Literal from './Literal';
import type * as NodeType from './NodeType';
import { NodeBase } from './shared/Node';

export default class ImportDeclaration extends NodeBase {
	declare attributes: ImportAttribute[];
	declare needsBoundaries: true;
	declare source: Literal<string>;
	declare specifiers: (ImportSpecifier | ImportDefaultSpecifier | ImportNamespaceSpecifier)[];
	declare type: NodeType.tImportDeclaration;

	// Do not bind specifiers or attributes
	bind(): void {}

	hasEffects(): boolean {
		return false;
	}

	/**
	 * @description 解析出当前模块的 imports
	 * 调用 Module 类里的 addImport 将其记录到 module.sourcesWithAttributes
	 * @author justinhone <justinhonejiang@gmail.com>
	 * @date 2024-10-01 14:27
	 */
	initialise(): void {
		super.initialise();
		this.scope.context.addImport(this);
	}

	render(code: MagicString, _options: RenderOptions, nodeRenderOptions?: NodeRenderOptions): void {
		code.remove(nodeRenderOptions!.start!, nodeRenderOptions!.end!);
	}

	protected applyDeoptimizations() {}
}

ImportDeclaration.prototype.needsBoundaries = true;
