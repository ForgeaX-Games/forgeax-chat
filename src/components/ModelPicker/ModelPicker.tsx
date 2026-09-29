import { ChevronDown, Eye, EyeOff, Loader2, Search } from "lucide-react";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	type ModelCatalogEntry,
	type ModelCatalogState,
	setAgentModels,
	setModelHidden,
	useModelCatalog,
	useTranslation,
} from "../../runtime";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import "./ModelPicker.css";

export interface ModelPickerWriteTarget {
	sid: string;
	agentPath: string;
}

interface BaseProps {
	variant?: "button" | "pill" | "inline";
	writeToAgent?: ModelPickerWriteTarget | null;
	rowBadge?: (model: ModelCatalogEntry) => ReactNode;
	className?: string;
	fallbackLabel?: string;
	displayLabel?: string;
	triggerTitle?: string;
	disabled?: boolean;
	disabledReason?: string;
	providerId?: string | null;
}

interface SingleProps extends BaseProps {
	mode?: "single";
	value: string | null;
	onChange: (next: string | null) => void;
}

interface MultiProps extends BaseProps {
	mode: "multi";
	value: Set<string>;
	onChange: (next: Set<string>) => void;
}

export type ModelPickerProps = SingleProps | MultiProps;

export function filterAndGroupModelCatalog(
	models: ModelCatalogEntry[] | null,
	query: string,
	showHidden: boolean,
): { gateway: ModelCatalogEntry[]; driver: ModelCatalogEntry[] } {
	const visible = showHidden
		? (models ?? [])
		: (models ?? []).filter((model) => !model.hidden);
	const normalizedQuery = query.trim().toLowerCase();
	const filtered = normalizedQuery
		? visible.filter((model) =>
				model.id.toLowerCase().includes(normalizedQuery),
			)
		: visible;
	return {
		gateway: filtered.filter((model) => model.source !== "driver"),
		driver: filtered.filter((model) => model.source === "driver"),
	};
}

export function nextModelPickerFocus(
	current: number,
	total: number,
	key: "ArrowDown" | "ArrowUp",
): number {
	if (total === 0) return current;
	if (key === "ArrowDown") return current < 0 ? 0 : (current + 1) % total;
	return current <= 0 ? total - 1 : current - 1;
}

function formatContext(n: number): string {
	if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
	return `${Math.round(n / 1000)}K`;
}

function ModelRowBadges({ model }: { model: ModelCatalogEntry }) {
	return (
		<>
			{typeof model.contextWindow === "number" && (
				<>
					<span className="mp-sep" aria-hidden="true">
						·
					</span>
					<span
						className="mp-ctx"
						title={`contextWindow=${model.contextWindow}`}
					>
						{formatContext(model.contextWindow)}
					</span>
				</>
			)}
			{model.reasoning && (
				<span className="mp-reasoning" title="reasoning supported">
					reasoning
				</span>
			)}
			{Array.isArray(model.input) && model.input.length > 0 && (
				<span className="mp-modalities">
					{model.input.map((modality) => (
						<span key={modality} className={`mp-modality r-${modality}`}>
							{modality}
						</span>
					))}
				</span>
			)}
		</>
	);
}

export function ModelPicker(props: ModelPickerProps) {
	const catalog = useModelCatalog(props.providerId);
	if (!catalog) return null;
	return <ModelPickerView {...props} catalog={catalog} />;
}

function ModelPickerView(
	props: ModelPickerProps & { catalog: ModelCatalogState },
) {
	const { t } = useTranslation();
	const {
		variant = "button",
		writeToAgent = null,
		rowBadge,
		className,
		fallbackLabel,
		triggerTitle,
		disabled = false,
		disabledReason,
		catalog: { models, driver, error, refresh },
	} = props;
	const mode = props.mode ?? "single";
	const [open, setOpen] = useState(variant === "inline");
	const [query, setQuery] = useState("");
	const [focused, setFocused] = useState(-1);
	const [opInFlight, setOpInFlight] = useState<string | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	const isMulti = mode === "multi";
	const singleValue = !isMulti ? (props as SingleProps).value : null;
	const multiValue = isMulti ? (props as MultiProps).value : null;
	const showHidden = isMulti || variant === "inline";

	const grouped = useMemo(
		() => filterAndGroupModelCatalog(models, query, showHidden),
		[models, query, showHidden],
	);
	const flat = useMemo(
		() => [...grouped.gateway, ...grouped.driver],
		[grouped],
	);

	useEffect(() => {
		if (variant === "inline") return;
		if (!open) {
			setFocused(-1);
			setQuery("");
		}
	}, [open, variant]);

	const commit = async (modelId: string) => {
		if (disabled) return;
		if (isMulti) {
			const next = new Set(multiValue ?? []);
			if (next.has(modelId)) next.delete(modelId);
			else next.add(modelId);
			(props as MultiProps).onChange(next);
			return;
		}
		if (writeToAgent && singleValue !== modelId) {
			if (opInFlight) return;
			setOpInFlight(modelId);
			try {
				const result = await setAgentModels(
					writeToAgent.sid,
					writeToAgent.agentPath,
					[modelId],
				);
				(props as SingleProps).onChange(result.selected ?? modelId);
				setOpen(false);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.warn(`[model-picker] set_agent_models failed: ${message}`, {
					modelId,
					agentPath: writeToAgent.agentPath,
					sid: writeToAgent.sid,
				});
				setOpen(false);
			} finally {
				setOpInFlight(null);
			}
			return;
		}
		(props as SingleProps).onChange(modelId);
		setOpen(false);
	};

	const handlePickerKeyDown = (event: ReactKeyboardEvent) => {
		if (flat.length === 0) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const key = event.key;
			setFocused((current) => nextModelPickerFocus(current, flat.length, key));
		} else if (event.key === "Enter") {
			const model = flat[focused];
			if (!model) return;
			event.preventDefault();
			void commit(model.id);
		}
	};

	const displayLabel = !isMulti
		? (props as SingleProps).displayLabel
		: undefined;
	const triggerLabel = isMulti
		? `${multiValue?.size ?? 0} selected`
		: (displayLabel ?? singleValue ?? fallbackLabel ?? "pick model");
	const total = (models ?? []).filter(
		(model) => showHidden || !model.hidden,
	).length;

	const toggleHidden = async (model: ModelCatalogEntry) => {
		if (opInFlight) return;
		setOpInFlight(model.id);
		try {
			await setModelHidden(model.id, !model.hidden);
			await refresh();
		} catch (err) {
			console.warn("[model-picker] set_model_hidden failed", {
				id: model.id,
				err,
			});
		} finally {
			setOpInFlight(null);
		}
	};

	const renderRow = (model: ModelCatalogEntry, index: number) => {
		const isCurrent = isMulti
			? (multiValue?.has(model.id) ?? false)
			: singleValue === model.id;
		const inflight = opInFlight === model.id;
		const contents = (
			<>
				{isMulti && (
					<span className="mp-check" aria-hidden="true">
						<input type="checkbox" checked={isCurrent} readOnly tabIndex={-1} />
					</span>
				)}
				<span className={`mp-id${model.hidden ? " is-hidden-model" : ""}`}>
					{model.id}
				</span>
				<ModelRowBadges model={model} />
				{model.live && (
					<span
						className="mp-live"
						title="served by the LiteLLM /v1/models proxy"
					>
						live
					</span>
				)}
				{model.source === "driver" && (
					<span
						className="mp-driver"
						title={`${model.driverLabel ?? model.driverId ?? "driver"} · subscription runtime · no local cost metering`}
					>
						driver
					</span>
				)}
				{model.hidden && (
					<span className="mp-hidden-tag" title="hidden from Composer picker">
						hidden
					</span>
				)}
			</>
		);
		const tail = (
			<span className="mp-tail">
				{rowBadge ? rowBadge(model) : null}
				{!rowBadge && !isMulti && isCurrent && (
					<span className="mp-arrow" title="current">
						✓
					</span>
				)}
				{!rowBadge && !isMulti && inflight && (
					<Loader2 size={11} className="mp-spin" />
				)}
			</span>
		);
		const item = isMulti ? (
			<button
				type="button"
				role="menuitemcheckbox"
				aria-checked={isCurrent}
				className={`mp-item${focused === index ? " is-focused" : ""}${isCurrent ? " is-current" : ""}`}
				onMouseEnter={() => setFocused(index)}
				onClick={() => void commit(model.id)}
				data-testid={`model-picker-row-${model.id}`}
			>
				{contents}
				{tail}
			</button>
		) : (
			<button
				type="button"
				role="menuitem"
				aria-current={isCurrent ? "true" : undefined}
				className={`mp-item${focused === index ? " is-focused" : ""}${isCurrent ? " is-current" : ""}`}
				onMouseEnter={() => setFocused(index)}
				onClick={() => void commit(model.id)}
				data-testid={`model-picker-row-${model.id}`}
			>
				{contents}
				{tail}
			</button>
		);
		return (
			<div key={model.id} className="mp-row">
				{item}
				{showHidden && (
					<button
						type="button"
						className="mp-eye"
						title={
							model.hidden
								? t("modelPicker.showInComposer")
								: t("modelPicker.hideFromComposer")
						}
						aria-label={model.hidden ? "show in picker" : "hide from picker"}
						data-testid={`model-picker-eye-${model.id}`}
						disabled={inflight}
						onClick={() => void toggleHidden(model)}
					>
						{model.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
					</button>
				)}
			</div>
		);
	};

	const renderMenu = () => (
		<div
			className={`mp-menu${variant === "inline" ? " mp-menu-inline" : " mp-menu--popover"}`}
			role="menu"
			aria-label="Model picker"
			data-testid="model-picker-menu"
			onKeyDown={handlePickerKeyDown}
		>
			<div className="mp-search">
				<Search size={12} aria-hidden="true" />
				<input
					ref={inputRef}
					type="text"
					value={query}
					placeholder={`Search ${total} models…`}
					onChange={(event) => {
						setQuery(event.target.value);
						setFocused(0);
					}}
					aria-label="Filter models"
					data-testid="model-picker-search"
				/>
				<button
					type="button"
					className="mp-refresh"
					title="refetch list_models"
					onClick={() => void refresh()}
				>
					↻
				</button>
			</div>
			{error && <div className="mp-err">{error}</div>}
			{!models && !error && <div className="mp-loading">loading…</div>}
			{models && flat.length === 0 && !query && driver?.source === "none" && (
				<div
					className="mp-empty mp-unavailable"
					data-testid="model-picker-unavailable"
					title={driver.error}
				>
					<div>catalog unavailable for {driver.id}</div>
					{driver.error && (
						<div className="mp-unavailable-detail">{driver.error}</div>
					)}
				</div>
			)}
			{models &&
				flat.length === 0 &&
				!(driver?.source === "none" && !query) && (
					<div className="mp-empty">
						{query ? `no matches for "${query}"` : "catalog empty"}
					</div>
				)}
			{grouped.gateway.map((model, index) => renderRow(model, index))}
			{grouped.driver.length > 0 && (
				<>
					<div className="mp-group" aria-hidden="true">
						{grouped.driver[0]?.driverLabel ?? "driver"} ·{" "}
						{grouped.driver.length} · no local cost
						{(driver?.source === "last-known" ||
							driver?.source === "static") && (
							<span
								className="mp-stale"
								data-testid="model-picker-stale-badge"
								title={
									driver.source === "last-known"
										? `cached from the last successful fetch${driver.error ? ` — live fetch failed: ${driver.error}` : ""}`
										: `kernel-declared static defaults${driver.error ? ` — discovery failed: ${driver.error}` : ""}`
								}
							>
								{driver.source === "last-known" ? "cached" : "preset"}
							</span>
						)}
					</div>
					{grouped.driver.map((model, index) =>
						renderRow(model, grouped.gateway.length + index),
					)}
				</>
			)}
			<div className="mp-foot">
				↑↓ navigate · ⏎ {isMulti ? "toggle" : "select"} · Esc close
			</div>
		</div>
	);

	if (variant === "inline") {
		return (
			<div
				ref={rootRef}
				className={`mp-root mp-inline${className ? ` ${className}` : ""}`}
			>
				{renderMenu()}
			</div>
		);
	}

	const triggerClass =
		variant === "pill" ? "mp-trigger mp-pill" : "mp-trigger mp-button";
	return (
		<div ref={rootRef} className={`mp-root${className ? ` ${className}` : ""}`}>
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<button
						type="button"
						className={`${triggerClass}${open ? " is-open" : ""}`}
						disabled={disabled}
						title={disabled ? (disabledReason ?? triggerTitle) : triggerTitle}
						data-testid="model-picker-trigger"
					>
						<span className="mp-trigger-label">{triggerLabel}</span>
						<ChevronDown size={11} />
					</button>
				</PopoverTrigger>
				<PopoverContent
					side="top"
					align="start"
					sideOffset={4}
					className="w-auto border-0 bg-transparent p-0 shadow-none"
				>
					{renderMenu()}
				</PopoverContent>
			</Popover>
		</div>
	);
}
