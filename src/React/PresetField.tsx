import React, { useId, useState } from "react";

const durations = [
  [1, "1分"],
  [5, "5分"],
  [15, "15分"],
  [30, "30分"],
  [60, "1時間"],
  [360, "6時間"],
  [720, "12時間"],
  [1440, "1日"],
  [4320, "3日"],
  [10080, "7日"],
  [20160, "14日"],
  [43200, "30日"],
  [129600, "90日"],
  [525600, "365日"],
] as const;
const sizes = [
  [10e6, "10 MB"],
  [50e6, "50 MB"],
  [100e6, "100 MB"],
  [500e6, "500 MB"],
  [1e9, "1 GB"],
  [2e9, "2 GB"],
  [5e9, "5 GB"],
  [10e9, "10 GB"],
  [20e9, "20 GB"],
  [50e9, "50 GB"],
  [100e9, "100 GB"],
  [200e9, "200 GB"],
] as const;
export function durationLabel(minutes: number) {
  if (minutes % 1440 === 0) return `${minutes / 1440}日`;
  if (minutes % 60 === 0) return `${minutes / 60}時間`;
  return `${minutes}分`;
}
/** Values stay in minutes / bytes; presets and custom units share the same validation. */
export function PresetField({
  label,
  kind = "duration",
  value: controlled,
  defaultValue = null,
  onChange,
  max,
  name,
  keepCurrent = false,
  unlimited = false,
}: {
  label: string;
  kind?: "duration" | "size";
  value?: number | null;
  defaultValue?: number | null;
  onChange?: (value: number) => void;
  max: number;
  name?: string;
  keepCurrent?: boolean;
  unlimited?: boolean;
}) {
  const id = useId();
  const [internal, setInternal] = useState<number | null>(defaultValue);
  const value = controlled === undefined ? internal : controlled;
  const [custom, setCustom] = useState(false);
  const units =
    kind === "duration"
      ? ([
          [1, "分"],
          [60, "時間"],
          [1440, "日"],
        ] as const)
      : ([
          [1, "バイト"],
          [1e3, "KB"],
          [1e6, "MB"],
          [1e9, "GB"],
        ] as const);
  const [unit, setUnit] = useState(() =>
    kind === "duration" ? (value && value % 1440 === 0 ? 1440 : 1) : 1e6,
  );
  const choices: (readonly [number, string])[] = [
    ...(kind === "duration" ? durations : sizes),
  ].filter(([n]) => n <= max);
  if (unlimited && kind === "duration") choices.unshift([0, "無期限"]);
  if (!choices.some(([n]) => n === max))
    choices.push([
      max,
      `上限（${kind === "duration" ? durationLabel(max) : `${max / 1e9} GB`}）`,
    ]);
  const isCustom =
    custom || (value !== null && !choices.some(([n]) => n === value));
  const setValue = (next: number) => {
    setInternal(next);
    onChange?.(next);
  };
  return (
    <div className="preset-field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={isCustom ? "custom" : value === null ? "keep" : String(value)}
        onChange={(e) => {
          const selected = e.target.value;
          setCustom(selected === "custom");
          if (selected === "keep") {
            setInternal(null);
            return;
          }
          if (selected === "custom") {
            if (value === null)
              setValue(Math.min(kind === "duration" ? 1440 : 1e9, max));
            return;
          }
          setValue(Number(selected));
        }}
      >
        {keepCurrent && <option value="keep">現在の期限を維持</option>}
        {choices.map(([n, text]) => (
          <option key={n} value={n}>
            {text}
          </option>
        ))}
        <option value="custom">カスタム…</option>
      </select>
      {isCustom && (
        <div className="preset-custom">
          <input
            aria-label={`${label}（カスタム値）`}
            type="number"
            min={1 / unit}
            max={max / unit}
            step="any"
            value={(value ?? 0) / unit}
            required
            onChange={(e) =>
              setValue(Math.round(Number(e.target.value) * unit))
            }
          />
          <select
            aria-label={`${label}（単位）`}
            value={unit}
            onChange={(e) => setUnit(Number(e.target.value))}
          >
            {units.map(([n, text]) => (
              <option key={n} value={n}>
                {text}
              </option>
            ))}
          </select>
        </div>
      )}
      {name && <input type="hidden" name={name} value={value ?? ""} />}
    </div>
  );
}
