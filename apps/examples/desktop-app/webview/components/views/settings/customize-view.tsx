"use client";

import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { openExternalUrl } from "@/lib/desktop-client";
import { PageFrame, PageHeader } from "../page-layout";
import { PiExtensionsView } from "./pi-extensions-view";

export function CustomizeView() {
	return (
		<PageFrame>
			<PageHeader
				actions={
					<Button
						onClick={() => void openExternalUrl("https://pi.dev/packages")}
						size="sm"
						type="button"
						variant="outline"
					>
						<ExternalLink className="size-4" /> Pi packages
					</Button>
				}
				description="Manage the Pi extensions configured in your local workspace and global Pi agent."
				title="Pi extensions"
			/>
			<PiExtensionsView />
		</PageFrame>
	);
}
