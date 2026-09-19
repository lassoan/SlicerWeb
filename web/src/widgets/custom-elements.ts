/**
 * Registers the Slicer web widgets as standard custom elements (<sw-slider>, <sw-node-selector>, ...).
 *
 * Used by:
 *  - the Python qt/ctk compatibility layer (slicerweb.qtcompat), which creates these elements for
 *    Python scripted module GUIs in the browser;
 *  - desktop 3D Slicer (SlicerWebWidgets extension), which shows web module GUIs in QtWebEngine and
 *    connects them to Slicer through QWebChannel (see core/bridge.ts).
 *
 * Elements render in the light DOM (no shadow root) so that the page stylesheet (slicerweb-widgets.css,
 * OHIF theme) applies. Properties can be set as element properties; events are CustomEvents named
 * after Qt signals with the signal arguments in event.detail (an array).
 */
import { defineCustomElement } from "vue";
import "../styles/main.css";
import * as widgets from "./index";
import { setBridge, QWebChannelBridge, type SlicerBridge } from "../core/bridge";

const tagNames: Record<string, string> = {
  SwButton: "sw-button",
  SwCheckBox: "sw-checkbox",
  SwCollapsible: "sw-collapsible",
  SwColorPicker: "sw-colorpicker",
  SwComboBox: "sw-combobox",
  SwFormRow: "sw-formrow",
  SwGroupBox: "sw-groupbox",
  SwLabel: "sw-label",
  SwLineEdit: "sw-lineedit",
  SwNodeSelector: "sw-node-selector",
  SwProgressBar: "sw-progressbar",
  SwRangeSlider: "sw-range-slider",
  SwSlider: "sw-slider",
  SwSpinBox: "sw-spinbox",
  SwTabWidget: "sw-tabwidget",
  SwTextEdit: "sw-textedit",
};

export function registerSlicerWidgets() {
  for (const [name, component] of Object.entries(widgets)) {
    const tag = tagNames[name];
    if (tag && !customElements.get(tag)) {
      customElements.define(tag, defineCustomElement(component as any, { shadowRoot: false }));
    }
  }
}

/** Connect widgets to Slicer. In desktop Slicer (QtWebEngine) the QWebChannel bridge is used. */
export function connectSlicer(customBridge?: SlicerBridge) {
  setBridge(customBridge ?? new QWebChannelBridge());
}

registerSlicerWidgets();
(window as any).SlicerWebWidgets = { registerSlicerWidgets, connectSlicer };
