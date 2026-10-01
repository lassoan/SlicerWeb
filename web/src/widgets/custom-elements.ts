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
  SwPathLineEdit: "sw-pathlineedit",
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
      // The element is the widget: what is set on it - shown or hidden (style), enabled, its place in
      // a layout, its tooltip - stays on it, and is not copied onto the root of what it renders. A copy
      // is only updated while the element is in the page, so a widget hidden, taken out (the panel of
      // another module shown) and shown again came back with its content still hidden.
      customElements.define(tag, defineCustomElement(component as any, { shadowRoot: false, inheritAttrs: false }));
    }
  }
}

/** Connect widgets to Slicer. In desktop Slicer (QtWebEngine) the QWebChannel bridge is used. */
export function connectSlicer(customBridge?: SlicerBridge) {
  setBridge(customBridge ?? new QWebChannelBridge());
}

registerSlicerWidgets();
(window as any).SlicerWebWidgets = { registerSlicerWidgets, connectSlicer };
