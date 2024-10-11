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

    /** @type {RollNode} */
    rootNode = null;

    /** @type {RollNode} */
    nodes = {};

    constructor(formula, contexts, options = {}) {
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
                formula = formula.replaceAll(variable, "0");
            }
        }

        this.formula = formula;
        this.options = options;

        this.populate(contexts);
    }

    /**
     * Method used to build the roll data needed for a Roll.
     *
     * @param {string} formula The formula for the Roll
     * @param {RollContext} contexts The data context for this roll
     * @param {Object} options
     * @returns {Promise<RollInfo>}
     */
    static async buildRoll(formula, contexts, options) {
        let tree = new RollTree(formula, contexts, options);
        let allRolledMods = tree.getReferenceModifiers();

        let enabledParts;
        let result = {
            button: '',
            mode: '',
            modifiers: tree.getModifiers(),
            bonus: null,
            rolls: [],
        };

        if (options.skipUI) {
            result.button = options.defaultButton || (options.buttons ? (Object.values(options.buttons)[0].id ?? Object.values(options.buttons)[0].label) : "roll");
            result.mode = game.settings.get("core", "rollMode");
            result.bonus = null;
            // TODO(levirak): don't roll every part when skipping UI? (E.g., when holding SHIFT)
            enabledParts = options.parts;
        } else {
            if (options.debug) {
                console.log(["Available modifiers", allRolledMods]);
            }

            let uiResult = await RollDialog.showRollDialog(tree, formula, contexts, allRolledMods, options.mainDie, {
                buttons: options.buttons,
                defaultButton: options.defaultButton,
                title: options.title,
                dialogOptions: options.dialogOptions,
                parts: options.parts,
            });
            result.button = uiResult.button;
            result.mode = uiResult.rollMode
            result.bonus = uiResult.bonus;
            enabledParts = uiResult.parts?.filter(part => part.enabled);
        }

        if (result.button === null) {
            console.log('Roll was cancelled');
            result.button = 'cancel';
            return result;
        }

        for (const [key, value] of Object.entries(tree.nodes)) {
            if (value.referenceModifier) {
                value.isEnabled = value.referenceModifier.enabled;
            }
        }

        const finalRollFormula = tree.rootNode.resolve();
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

                if (options.debug) {
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

            if (options.debug) {
                console.log([`Final roll results outcome`, formula, allRolledMods, finalRollFormula]);
            }

            result.rolls.push({ formula: finalRollFormula, node: tree.rootNode });
        }

        return result;
    }

    /**
     * Populate `this.rootNode` and `this.nodes` with values according to `contexts`
     * @param {RollContext} contexts The data context used to populate this tree's nodes
     */
    populate(contexts) {
        if (this.options.debug) {
            console.log(`Resolving '${this.formula}'`);
            console.log(contexts);
            console.log(this.options);
        }

        this.rootNode = new RollNode(this.formula, this, this.options);
        this.nodes = {};

        this.nodes[this.formula] = this.rootNode;
        this.rootNode.populate(this.nodes, contexts);
    }

    /**
     * Get the reference modifiers from this objects nodes.
     * @returns {SFRPGModifier[]}
     */
    getReferenceModifiers() {
        return Object.values(this.nodes)
            .filter(x => x.referenceModifier !== null)
            .map(x => x.referenceModifier);
    }

    /**
     * Get the reference and calculated modifiers from this objects nodes.
     * @returns {SFRPGModifier[]}
     */
    getModifiers() {
        let rollMods = [];
        for (let value of Object.values(this.nodes)) {
            if (value.referenceModifier) {
                rollMods.push(value.referenceModifier);
            }
            if (value.calculatedMods) {
                for (let mod of value.calculatedMods) {
                    if (rollMods.findIndex((x) => x.name === mod.bonus.name) === -1 && this.formula.indexOf(mod.bonus.name) === -1) {
                        rollMods.push(mod.bonus);
                    }
                }
            }
        }
        return rollMods;
    }
}
