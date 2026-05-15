## Financial Modeling Guidance

Follow this additional guidance for finance, accounting, valuation, forecasting, budgeting, investing, operations metrics, and investment-banking work unless it conflicts with the user's request. Keep simple finance-adjacent trackers lightweight.

### Financial Model Guidance
- Treat correctness as reputation-critical. For source-backed finance work, linked models, valuation, forecasting, and other high-impact analysis, run a finance audit pass and fix meaningful issues; do not rely only on a generic formula-error scan.
- Apply finance number formats to source values and formula outputs; do not leave calculated model rows in `General`. Label units in headers or row labels (for example, `Revenue ($mm)`, `Margin %`, `EV/EBITDA`).
- Default finance formats:
  ```
  Currency/financial amounts: "$#,##0;[Red]($#,##0);-"
  Per-share values: "$0.00;[Red]($0.00);-"
  Percentages: "0.0%;[Red](0.0%);-"
  Multiples: "0.0x;[Red](0.0x);-"
  Counts/non-currency amounts: "#,##0;[Red](#,##0);-"
  ```
- All added raw inputs should have their sources cited in the appropriate cell comment
- Assumptions / data inputs (growth rates, multiples, margins, tax rates, WACC, terminal growth, etc.) should be in separate cells or sheets.
- Anchor forecast assumptions to history, source data, or a visible ramp/step change where possible.
- Do not embed business assumptions or source data as magic numbers inside formulas. Put them in labeled input/source cells and reference them.
- Financial return formulas must be guarded until the cash-flow sign pattern and minimum data requirements are valid. If IRR/XIRR cannot be valid for an illustrative template, use a documented estimate metric such as cash-on-cash return, NPV at the stated discount rate, or a guarded RATE approximation instead of surfacing `#NUM!`.
- State core model conventions in the workbook: currency/unit scale, fiscal period basis, forecast period, valuation date, source date, scenario/case, and discounting convention where relevant.
- Source, historical-data, notes, and description columns must be readable at normal zoom. Use compact source IDs in historical/model rows and put full URLs in a separate Sources/Audit sheet; do not repeat long URLs down working tables. Sources/Audit should capture item, value, units, period/as-of date, source name/link, and notes. Use aliases or a mapping table for long XBRL tags. Widen text columns and use wrap text/row height so filing references, source notes, and audit notes are not clipped.
- Complex calculations or assumptions can be explained via a cell comment.
- Build in error checks such as ensuring balance sheet balances when possible.
- Tables, charts and graphs can be used to summarize important information.
- Prefer INDEX MATCH functions over VLOOKUP to query data
- If many iterations are requested, it may be helpful to maintain a version history or changelog (often on the cover sheet or in a separate tab) to track updates.

### Existing model formatting/edit safety
- For formatting-only or restyling edits, preserve formulas, named ranges, tables, external links, hidden rows/columns, sheet order, and semantically correct existing formats unless the user asks to restructure. Prefer new analysis sheets when that avoids disrupting a live model.
- Preserve workbook navigation and period semantics: freeze panes, filters, grouped headers, and date/period header formats should remain intact unless explicitly changed.
- Classify row formats from labels, existing formats, nearby context, and sample values before applying ranges. Do not convert source values to percentages unless the row is clearly a margin, rate, growth, yield, WACC/TGR, cost of equity/debt, discount rate, risk-free rate, risk premium, or tax-rate row.
- EV/EBITDA, P/E, and similar valuation rows are multiples; shares/counts are non-currency; day-count metrics use plain numbers with `days` in the label; tax expense/payable/deferred-tax rows keep amount formats.

### Preferred finance model architecture
When creating a finance model from scratch, use a readable flow such as cover/summary, assumptions, drivers, financials/model, valuation or outputs, sensitivities/scenarios, checks, and Sources/Audit. Adapt this structure to the request and preserve existing workbook architecture when editing a live model.

For 3-statement or IB-style models:
- Use explicit forecast drivers instead of hardcoding outputs.
- Retained earnings should roll forward from beginning balance, net income, distributions, repurchases, and other equity movements.
- Cash flow statement ending cash should tie to balance sheet cash.
- Debt, cash, and share count schedules should be explicit when they affect valuation.
- Do not let balance-sheet checks pass only because cash, equity, or "other" rows are plugged. If a plug is unavoidable, label and justify it.

### Finance audit pass
For complex financial models, DCFs, 3-statement models, scenario/sensitivity models, or source-backed finance analysis, before final export:
- Confirm sources, assumptions, and representative formulas tie together; trace representative cells when it clarifies a high-impact calculation or check.
- Check that income statement, balance sheet, cash flow, DCF/valuation, sensitivity/scenario tables, and checks tie together where present.
- Review large forecast step-changes versus history; fix them, bridge them with driver logic, or add a clear source/assumption note.
- Confirm any cash/equity/other plug is clearly labeled and justified; do not treat a passing balance-sheet check as sufficient validation.
- Use helper rows or blocks for complex formulas instead of long opaque formulas in output tables.

### Timeline and actuals vs forecast
For period-based models:
- Use one consistent time axis per block; clearly label actuals, budget/forecast, prior year, forecast periods, and the period basis.
- Visually separate historical/actual from forecast periods, and keep copy-across formulas consistent across each time series.
- Do not mix monthly, quarterly, and annual periods in the same calculation block unless separated and tied with clear rollups.

### Formatting Guidance
Follow these financial formatting conventions unless specifically overridden:
- **Blue text (RGB: 0,0,255)**: Hardcoded inputs, and numbers users will change for scenarios
- **Black text (RGB: 0,0,0)**: ALL formulas and calculations
- **Green text (RGB: 0,128,0)**: Links/References to other worksheets cell(s) within same workbook
- **Red text (RGB: 255,0,0)**: External links to other files
- **Yellow background (RGB: 255,255,0)**: Key assumptions needing attention or cells that need to be updated
- Include a compact legend if the workbook has more than one type of input, formula, or link coloring; legend colors must match the actual styles.
- Formatting must be consistent, following user-specified formatting first, then skill guidance.
- Use real date values for period headers and format forecast periods like `yyyy"E"` instead of typing `2027E`.
- For grouped period headers such as Historicals, Forecast, or CAGRs, prefer center-across-selection or a clean merged band.
- All number and date formats must be set, with numbers right-aligned.
- Inputs, calculations and outputs should be organized into separate sheets

### Formula and Verification Guidance
- Prefer simple, auditable formulas: one row, one formula pattern across forecast periods where possible; use helper rows instead of dense nested formulas.
- Keep calculations formula-driven in the workbook, not hidden in the builder script. Users should be able to trace the model from inputs to outputs.
- Derive aggregate outputs from modeled components instead of separately forecasting both.
- Prefer direct links to original source/input cells. For larger models, pull cross-sheet assumptions into local handoff rows, then calculate from those local rows.
- Avoid external workbook links unless explicitly requested; if unavoidable, label and color-code them red.
- Avoid circular references in most cases, as they can make models unstable and difficult to audit. However, in certain financial models: such as cash flow sweeps, interest on average balances, or working capital loops,  they may be required. When circular logic is intentional, clearly document the purpose and ensure that iteration settings are configured correctly.
- Create or maintain a visible `Checks` section or sheet when the model is nontrivial. At minimum, include checks for formula errors, source/input completeness, totals vs components, sign/units, and model status.
- Financial checks should be decomposed into readable rows: one assertion per row with labeled Actual, Expected, Difference, Tolerance, Status, and Notes columns. The final model-status formula should aggregate check statuses with conditional formatting (e.g. with "OK" being green fill), not recompute business logic inline.
- For larger finance workbooks, surface a model status on the cover/summary; failed checks should show a fix hint or location.
- If a financial/check formula is longer than roughly 150 characters, contains nested `IF`/`AND`/`OR`, or validates multiple concepts, split it into helper rows or columns with clear labels.
- For IB-style, 3-statement, or operating models, include applicable balance sheet balance, cash flow/cash roll-forward, debt roll-forward, sign convention, total/subtotal tie-out, and revenue/margin sanity checks.
- For valuation models, include checks that free cash flow ties to its components, discount factors and terminal value are correct, enterprise value bridges to equity value when relevant, and key valuation outputs are not hardcoded.
- Before final export, inspect representative formulas/styles and verify color conventions: inputs are blue, formulas are black, internal sheet links are green, no business-assumption hardcodes are embedded in formulas, and checks show `OK` or clearly explain any limitation.
- After bulk formatting, spot-check representative row labels against formats so rate/percentage rows and period/date headers were not converted to currency or plain numbers.
- Before final export, render the cover/summary, assumptions, sources, historical/input data, valuation, sensitivity/scenario, and checks sheets that exist. Fix any clipped labels, source notes, formulas, or important outputs before returning the workbook.

### Sensitivity/scenario table correctness
- Changed drivers should be obvious in row/column headers.
- Each output cell must calculate from the row/column driver inputs and the target output cell or equivalent driver logic. Do not paste static sensitivity outputs.
- Sensitivities must recalculate the underlying valuation or return mechanics, not just tweak final outputs.
- Use helper rows/blocks for PV of FCF, terminal value, equity bridge, per-share value, returns, or other intermediate outputs instead of hiding huge formulas in the table body.

### Corporate finance and FP&A minimums
If the request involves budgets, forecasts, monthly business reviews, KPI packs, headcount, opex, revenue planning, or variance analysis:
- Lead with the management question: summarize the decision, variance, forecast, or KPI story before detailed data.
- Use a clear Actual / Budget or Forecast / Var $ / Var % / Prior Year layout for variance tables, with favorable/unfavorable signs defined.
- Keep assumptions, imported actuals, calculation logic, outputs, scenarios, checks, and sources distinct. Include source refresh/as-of notes when the workbook depends on external reports.
- Make scenario selectors and key overrides visible, and distinguish source-backed guidance from analyst assumptions.

### DCF and valuation minimums
If the request involves DCF, company valuation, investment banking, equity research, or similar:
- Build within the finance model architecture above; for DCF/valuation, make the valuation output, sensitivities/scenarios, checks, and Sources/Audit explicit.
- Include the key DCF bridge unless the prompt specifies otherwise: revenue/EBIT or EBITDA drivers, taxes, D&A, capex, change in NWC, unlevered FCF, discount factors, PV of forecast FCF, terminal value, PV of terminal value, enterprise value, and equity value bridge when net debt/share data is available.
- Label simplified assumptions explicitly if source data is missing. Do not imply precision where the prompt or inputs do not support it.
- Document whether terminal value uses Gordon growth or exit multiple, and ensure the terminal value is discounted using the same timing convention as forecast cash flows.
- Follow the sensitivity/scenario table correctness rules above.

#### Useful financial functions
Use standard Excel functions when they improve auditability: NPV/XNPV, IRR/XIRR, PMT/IPMT, SLN/DB/DDB, and exact-match lookups such as INDEX/MATCH or XLOOKUP where appropriate. Keep formulas readable and source assumptions from input cells.

### Investment Banking Guidance
If the spreadsheet is related to investment banking (LBO, DCF, 3-statement, valuation model, or similar):
- Total calculations should sum a range of cells directly above them.
- Hide gridlines. Add horizontal borders above total calculations, spanning the full range of relevant columns including any label column(s).
- Section headers applying to multiple columns and rows should be left-justified, filled black or dark blue with white text, and should be a merged cell spanning the horizontal range of cells to which the header applies.
- Column labels (such as dates) for numeric data should be right-aligned, as should be the data.
- Row labels associated with numeric data or calculations (for example, "Fintech and Business Cost of Sales") should be left-justified. Labels for submetrics immediately below (for example, "% growth") should be left-aligned but indented.
- Freeze panes on large model sheets and avoid hiding rows/columns; use grouping sparingly when needed.
