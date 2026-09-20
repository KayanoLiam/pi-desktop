import { describe, expect, it, vi } from "vitest";
import { handleCommand } from "./commands";
import { createSidecarContext } from "./context";

const { listPiModelCatalog } = vi.hoisted(() => ({
	listPiModelCatalog: vi.fn(),
}));
vi.mock("./pi-model-catalog", () => ({ listPiModelCatalog }));

describe("Pi catalog command", () => {
	it("routes Pi catalog requests without going through Cline's providers", async () => {
		const catalog = {
			providers: [
				{
					id: "pi-custom",
					name: "Custom",
					models: [{ id: "shared", name: "Shared" }],
				},
			],
		};
		listPiModelCatalog.mockResolvedValue(catalog);
		expect(
			await handleCommand(
				createSidecarContext("/workspace"),
				"list_pi_model_catalog",
				{},
			),
		).toEqual(catalog);
		expect(listPiModelCatalog).toHaveBeenCalledExactlyOnceWith();
	});
});
