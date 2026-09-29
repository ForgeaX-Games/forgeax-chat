import type { PillPayload } from "@forgeax/chat/runtime";
import { useTranslation } from "@forgeax/chat/runtime";
import { useId } from "react";
import "./PillChip.css";

interface Props {
	payload: PillPayload;
	/** When true, chip belongs to the composer editor and behaves as an atomic
	 *  contenteditable=false unit. Backspace deletes it whole. */
	editable?: boolean;
}

export function PillChip({ payload, editable = false }: Props) {
	const { t } = useTranslation();
	const tooltipId = useId();

	return (
		<span
			className={`kbl-pill kbl-pill-${payload.kind}`}
			contentEditable={editable ? false : undefined}
			data-pill="1"
			data-pill-kind={payload.kind}
			aria-describedby={tooltipId}
		>
			{payload.icon && (
				<span className="kbl-pill-icon" aria-hidden="true">
					{payload.icon}
				</span>
			)}
			<span className="kbl-pill-label">{payload.display}</span>
			<span
				id={tooltipId}
				className="kbl-pill-tip"
				contentEditable={false}
				role="tooltip"
			>
				<span className="kbl-pill-tip-title">{payload.tooltip.title}</span>
				{payload.tooltip.lines.map((line) => (
					<span key={line} className="kbl-pill-tip-line">
						{line}
					</span>
				))}
				<span
					className="kbl-pill-tip-detail"
					title={t("pillChip.expandedFormTip")}
				>
					{payload.detail}
				</span>
			</span>
		</span>
	);
}
