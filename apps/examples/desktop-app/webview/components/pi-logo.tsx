import { cn } from "@/lib/utils";

/** Vector tracing of the three geometric shapes in the supplied Pi logo. */
export function PiLogo({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			className={cn("shrink-0", className)}
			viewBox="0 0 200 200"
			fill="none"
		>
			<path fill="#EE9183" d="M0 0H150V100H100V50H0Z" />
			<path fill="#4D9EB9" d="M0 50H50V100H100V150H50V200H0Z" />
			<path fill="#F2C158" d="M150 100H200V200H150Z" />
		</svg>
	);
}

export function PiWelcomeHero() {
	return (
		<div className="pi-welcome-hero" data-welcome-hero aria-hidden="true">
			<div className="pi-welcome-grid" />
			<div className="pi-welcome-orbit" />
			<PiLogo className="pi-welcome-logo" />
		</div>
	);
}
