import { useId } from "react";
import { Popover, RadioGroup, Slider } from "radix-ui";
import { Brain } from "lucide-react";
import {
  pillDescription,
  pillText,
  usableControls,
  type RequestChoice,
  type RequestControlMeta,
} from "./request-choice.js";

const DEFAULT = "__agent_default__";

/** The composer-toolbar pill and its popover: a stepped slider for levels, a radio group for choices. Everything shown comes from the descriptors. */
export function RequestControls({
  controls,
  choice,
  onChange,
}: {
  controls: RequestControlMeta[];
  choice: RequestChoice;
  onChange: (next: RequestChoice) => void;
}) {
  const usable = usableControls(controls);
  const titleId = useId();
  if (!usable.length) return null;
  const { label, level, tier } = pillText(controls, choice);
  const set = (id: string, next: string | undefined) => {
    const copy = { ...choice };
    if (next === undefined) delete copy[id];
    else copy[id] = next;
    onChange(copy);
  };
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="request-pill"
          aria-label={`Request settings: ${pillDescription(controls, choice)}`}
          title="Request settings for the next turn"
        >
          <Brain size={15} aria-hidden="true" />
          <span className="pill-text">
            <span className="pill-label">{label}</span>
            {level && (
              <span className="pill-value">
                <span className="pill-colon" aria-hidden="true">
                  :{" "}
                </span>
                {level}
              </span>
            )}
            {tier && (
              <span className="pill-value">
                <span aria-hidden="true"> · </span>
                {tier}
              </span>
            )}
          </span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="request-popover"
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={8}
          aria-labelledby={titleId}
        >
          <p id={titleId} className="request-title">
            Next turn
          </p>
          {usable.map((control) =>
            control.kind === "level" ? (
              <LevelControl
                key={control.id}
                control={control}
                value={choice[control.id]}
                onChange={(next) => set(control.id, next)}
              />
            ) : (
              <ChoiceControl
                key={control.id}
                control={control}
                value={choice[control.id]}
                onChange={(next) => set(control.id, next)}
              />
            ),
          )}
          <button
            type="button"
            className="text-button request-reset"
            disabled={!Object.keys(choice).length}
            onClick={() => onChange({})}
          >
            Reset
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function LevelControl({
  control,
  value,
  onChange,
}: {
  control: RequestControlMeta;
  value: string | undefined;
  onChange: (next: string | undefined) => void;
}) {
  const stops = [
    { value: undefined as string | undefined, label: "Agent default" },
    ...control.options,
  ];
  const index = value === undefined ? 0 : Math.max(0, stops.findIndex((stop) => stop.value === value));
  const current = stops[index]!;
  const text =
    index === 0
      ? `Agent default${control.current ? ` (${control.current})` : ""}`
      : current.label;
  return (
    <div className="request-control">
      <p className="request-label">
        {control.label}: <strong>{text}</strong>
      </p>
      <Slider.Root
        className="slider"
        min={0}
        max={stops.length - 1}
        step={1}
        value={[index]}
        onValueChange={([next]) => onChange(stops[next ?? 0]?.value)}
      >
        <Slider.Track className="slider-track">
          <Slider.Range className="slider-range" />
        </Slider.Track>
        <Slider.Thumb
          className="slider-thumb"
          aria-label={control.label}
          aria-valuetext={text}
        />
      </Slider.Root>
      <div className="slider-stops" aria-hidden="true">
        {stops.map((stop, at) => (
          <span key={stop.value ?? DEFAULT} className={at === index ? "on" : ""}>
            {at === 0 ? "default" : stop.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function ChoiceControl({
  control,
  value,
  onChange,
}: {
  control: RequestControlMeta;
  value: string | undefined;
  onChange: (next: string | undefined) => void;
}) {
  const name = useId();
  const entries = [
    {
      value: DEFAULT,
      label: "Agent default",
      hint: control.current ? `Currently ${control.current}.` : "Use the agent's configuration.",
    },
    ...control.options,
  ];
  return (
    <div className="request-control">
      <p className="request-label" id={name}>
        {control.label}
      </p>
      <RadioGroup.Root
        className="radio-group"
        aria-labelledby={name}
        value={value ?? DEFAULT}
        onValueChange={(next) => onChange(next === DEFAULT ? undefined : next)}
      >
        {entries.map((entry) => {
          const id = `${name}-${entry.value}`;
          return (
            <div className="radio-row" key={entry.value}>
              <RadioGroup.Item className="radio" value={entry.value} id={id} aria-describedby={`${id}-hint`}>
                <RadioGroup.Indicator className="radio-dot" />
              </RadioGroup.Item>
              <label htmlFor={id}>
                <span>{entry.label}</span>
                {entry.hint && (
                  <span id={`${id}-hint`} className="muted small">
                    {entry.hint}
                  </span>
                )}
              </label>
            </div>
          );
        })}
      </RadioGroup.Root>
    </div>
  );
}
