import type { Dispatch, SetStateAction } from "react";
import type { Preferences } from "../preferences.js";
import { defaultPreferences } from "../preferences.js";
import { Field } from "../ui.js";
export function PreferencesPage({
  kind,
  value,
  setValue,
}: {
  kind: "appearance" | "chat";
  value: Preferences;
  setValue: Dispatch<SetStateAction<Preferences>>;
}) {
  const update = <K extends keyof Preferences>(key: K, next: Preferences[K]) =>
    setValue((old) => ({ ...old, [key]: next }));
  return (
    <div className="settings-content">
      <header>
        <span className="scope">This browser</span>
        <h1>{kind === "appearance" ? "Appearance" : "Chat preferences"}</h1>
        <p className="muted">
          Changes apply immediately. Raw config and model context stay
          unchanged.
        </p>
      </header>
      {kind === "appearance" ? (
        <div className="form-grid">
          <Field label="Theme">
            <select
              value={value.theme}
              onChange={(event) =>
                update("theme", event.target.value as Preferences["theme"])
              }
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </Field>
          <Field label="Density">
            <select
              value={value.density}
              onChange={(event) =>
                update("density", event.target.value as Preferences["density"])
              }
            >
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </select>
          </Field>
          {(
            [
              ["Chat font size", "chatSize", 14, 22],
              ["Code font size", "codeSize", 12, 20],
              ["Context panel width", "contextWidth", 240, 320],
              ["Inspector width", "inspectorWidth", 300, 360],
            ] as const
          ).map(([label, key, min, max]) => (
            <Field key={key} label={`${label} (${value[key]} px)`}>
              <input
                type="range"
                min={min}
                max={max}
                value={value[key]}
                onChange={(event) => update(key, Number(event.target.value))}
              />
            </Field>
          ))}
          <button
            onClick={() =>
              setValue((old) => ({
                ...old,
                ...Object.fromEntries(
                  [
                    "theme",
                    "density",
                    "chatSize",
                    "codeSize",
                    "contextWidth",
                    "inspectorWidth",
                  ].map((key) => [
                    key,
                    defaultPreferences[key as keyof Preferences],
                  ]),
                ),
              }))
            }
          >
            Reset appearance
          </button>
        </div>
      ) : (
        <div className="form-grid">
          <Field label="Send message with">
            <select
              value={value.sendMode}
              onChange={(event) =>
                update(
                  "sendMode",
                  event.target.value as Preferences["sendMode"],
                )
              }
            >
              <option value="enter">Enter</option>
              <option value="modifier">Ctrl/Cmd-Enter</option>
            </select>
          </Field>
          {(
            [
              ["Expand reasoning by default", "reasoning"],
              ["Expand tool details by default", "toolDetails"],
              ["Follow output when at the bottom", "follow"],
            ] as const
          ).map(([label, key]) => (
            <label className="checkbox-field" key={key}>
              <input
                type="checkbox"
                checked={value[key]}
                onChange={(event) => update(key, event.target.checked)}
              />
              {label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
