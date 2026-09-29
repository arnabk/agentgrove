import { createMemo } from "solid-js";

interface SliderProps {
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
  ariaLabel?: string;
  testId?: string;
  suffix?: string;
}

export default function Slider(props: SliderProps) {
  const displayValue = () => `${props.value}${props.suffix ?? ""}`;
  const step = createMemo(() => props.step ?? 1);
  return (
    <div class="flex items-center gap-3">
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={step()}
        value={props.value}
        onInput={(e) => props.onChange(Number(e.currentTarget.value))}
        aria-label={props.ariaLabel}
        data-testid={props.testId}
        class="ag-slider flex-1"
      />
      <span class="text-[12px] font-medium text-fg-muted tabular-nums w-8 text-right">
        {displayValue()}
      </span>
    </div>
  );
}
