import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownView, parseBlocks } from "./MarkdownView";

describe("MarkdownView", () => {
	test("keeps duplicate markdown nodes distinct by source offset", () => {
		const blocks = parseBlocks(
			"same\n\nsame\n\n- item\n- item\n\n| same | same |\n| --- | --- |\n| same | same |\n| same | same |",
		);

		const offsets = new Set<number>();
		for (const block of blocks) {
			expect(offsets.has(block.sourceOffset)).toBeFalse();
			offsets.add(block.sourceOffset);
			if (block.kind === "ul") {
				expect(new Set(block.items.map((item) => item.sourceOffset)).size).toBe(
					block.items.length,
				);
			}
			if (block.kind === "table") {
				const cells = [...block.header, ...block.rows.flat()];
				expect(new Set(cells.map((cell) => cell.sourceOffset)).size).toBe(
					cells.length,
				);
			}
		}
	});

	test("renders duplicate paragraphs, list items, and table cells", () => {
		const markup = renderToStaticMarkup(
			<MarkdownView
				text={
					"same\n\nsame\n\n- item\n- item\n\n| same | same |\n| --- | --- |\n| same | same |\n| same | same |"
				}
			/>,
		);

		expect(markup.match(/>same</g)?.length).toBe(8);
		expect(markup.match(/>item</g)?.length).toBe(2);
	});
});
