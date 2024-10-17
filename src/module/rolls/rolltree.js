import RollDialog from "../apps/roll-dialog.js";
import RollNode from "./rollnode.js";

/**
 * @typedef {Object} RollInfo
 * @property {string}          button
 * @property {string}          mode
 * @property {SFRPGModifier[]} modifiers
 * @property {string?}         bonus
 * @property {EachRoll[]}      rolls
 */

/**
 * @typedef {Object} EachRoll
 * @property {ResolvedRoll} formula
 * @property {RollNode}     node
 */

export default class RollTree {
    constructor(options = {}) {
        this.options = options;

        /** @type {RollNode} */
        this.rootNode = null;
        /** @type {RollNode} */
        this.nodes = {};
        /** @type {SFRPGModifier[]} */
        this.rollMods = [];
    }

    /**
     * Method used to build the roll data needed for a Roll.
     *
     * @param {string} formula The formula for the Roll
     * @param {RollContext} contexts The data context for this roll
     * @returns {Promise<RollInfo>}
     */
    async buildRoll(formula, contexts) {
        /** Initialize selectors. */
        if (contexts.selectors) {
            for (const selector of contexts.selectors) {
                const selectorTarget = selector.target;
                const firstValue = selector.options[0];
                if (selectorTarget && firstValue) {
                    contexts.allContexts[selectorTarget] = contexts.allContexts[firstValue];
                }
            }
        }

        /** Verify variable contexts, replace bad ones with 0. */
        const variableMatches = new Set(formula.match(/@([a-zA-Z.0-9_\-]+)/g));
        for (const variable of variableMatches) {
            const [context, remainingVariable] = RollNode.getContextForVariable(variable, contexts);
            if (!context) {
                console.log(`Cannot find context for variable '${variable}', substituting with a 0.`);
                const regexp = new RegExp(variable, "gi");
                formula = formula.replace(regexp, "0");
            }
        }

        const allRolledMods = this.populate(formula, contexts);

        let enabledParts;
        let result = {
            button: '',
            mode: '',
            modifiers: this.rollMods,
            bonus: result.bonus,
            rolls: [],
        };

        if (this.options.skipUI) {
            result.button = this.options.defaultButton || (this.options.buttons ? (Object.values(this.options.buttons)[0].id ?? Object.values(this.options.buttons)[0].label) : "roll");
            result.mode = game.settings.get("core", "rollMode");
            result.bonus = null;
            // TODO(levirak): don't roll every part when skipping UI? (E.g., when holding SHIFT)
            enabledParts = this.options.parts;
        } else {
            let parts;
            ({button: result.button, rollMode: result.mode, bonus: result.bonus, parts} = await this.displayUI(formula, contexts, allRolledMods));
            enabledParts = parts?.filter(x => x.enabled);
        }

        if (result.button === null) {
            console.log('Roll was cancelled');
            result.button = 'cancel';
            return result;
        }

        for (const [key, value] of Object.entries(this.nodes)) {
            if (value.referenceModifier) {
                value.isEnabled = value.referenceModifier.enabled;
            }
        }

        const finalRollFormula = this.rootNode.resolve(0, this.rollMods);
        if (enabledParts?.length > 0) {
            /* When the roll tree is passed parts, the primary formula & root node instead describes the bonuses that
             * are added to the primary section */
            for (const [partIndex, part] of enabledParts.entries()) {
                let finalSectionFormula = {
                    finalRoll: [
                        part.formula,
                        part.isPrimarySection ? finalRollFormula.finalRoll : '',
                    ].filter(Boolean).join(' + ') || '0',
                    formula: [
                        part.formula,
                        part.isPrimarySection ? finalRollFormula.formula : '',
                    ].filter(Boolean).join(' + ') || '0',
                };

                if (result.bonus) {
                    // TODO(levirak): should the bonus be applied to every damage section?
                    const operators = ['+', '-', '*', '/'];
                    if (!operators.includes(result.bonus[0])) {
                        finalSectionFormula.finalRoll += " +";
                        finalSectionFormula.formula += " +";
                    }
                    finalSectionFormula.finalRoll += " " + result.bonus;
                    finalSectionFormula.formula += game.i18n.format("SFRPG.Rolls.Dice.Formula.AdditionalBonus", { "bonus": result.bonus });
                }

                if (enabledParts.length > 1) {
                    part.partIndex = game.i18n.format("SFRPG.Damage.PartIndex", {partIndex: partIndex + 1, partCount: enabledParts.length});
                }

                if (this.options.debug) {
                    console.log([`Final roll results outcome`, formula, allRolledMods, finalSectionFormula]);
                }

                result.rolls.push({ formula: finalSectionFormula, node: part });
            }
        } else {
            if (result.bonus) {
                const operators = ['+', '-', '*', '/'];
                if (!operators.includes(result.bonus[0])) {
                    finalRollFormula.finalRoll += " +";
                    finalRollFormula.formula += " +";
                }
                finalRollFormula.finalRoll += " " + result.bonus;
                finalRollFormula.formula += game.i18n.format("SFRPG.Rolls.Dice.Formula.AdditionalBonus", { "bonus": result.bonus });
            }

            if (this.options.debug) {
                console.log([`Final roll results outcome`, formula, allRolledMods, finalRollFormula]);
            }

            result.rolls.push({ formula: finalRollFormula, node: this.rootNode });
        }

        return result;
    }

    populate(formula, contexts) {
        if (this.options.debug) {
            console.log(`Resolving '${formula}'`);
            console.log(contexts);
        }

        /* cache these for re-population */
        this.formula = formula;
        this.contexts = contexts;

        this.rootNode = new RollNode(formula, this, this.options);
        this.nodes = {};
        this.rollMods = [];

        this.nodes[formula] = this.rootNode;
        this.rootNode.populate(this.nodes, contexts);

        for (const [key, value] of Object.entries(this.nodes)) {
            if (value.referenceModifier) {
                this.rollMods.push(value.referenceModifier);
            }
            if (value.calculatedMods) {
                for (let calcModsI = 0; calcModsI < value.calculatedMods.length; calcModsI++) {
                    const mod = value.calculatedMods[calcModsI];
                    if (this.rollMods.findIndex((x) => x.name === mod.bonus.name) === -1 && formula.indexOf(mod.bonus.name) === -1) {
                        this.rollMods.push(mod.bonus);
                    }
                }
            }
        }

        return Object.values(this.nodes)
                .filter(x => x.referenceModifier !== null)
                .map(x => x.referenceModifier);
    }

    repopulate() {
        return populate(this.formula, this.contexts);
    }

    displayUI(formula, contexts, availableModifiers) {
        if (this.options.debug) {
            console.log(["Available modifiers", availableModifiers]);
        }
        return RollDialog.showRollDialog(
            this,
            formula,
            contexts,
            availableModifiers,
            this.options.mainDie,
            {
                buttons: this.options.buttons,
                defaultButton: this.options.defaultButton,
                title: this.options.title,
                dialogOptions: this.options.dialogOptions,
                parts: this.options.parts,
            });
    }
}
