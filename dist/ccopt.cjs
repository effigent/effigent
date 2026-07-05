#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/commander/lib/error.js
var require_error = __commonJS({
  "node_modules/commander/lib/error.js"(exports2) {
    var CommanderError2 = class extends Error {
      /**
       * Constructs the CommanderError class
       * @param {number} exitCode suggested exit code which could be used with process.exit
       * @param {string} code an id string representing the error
       * @param {string} message human-readable description of the error
       */
      constructor(exitCode, code, message) {
        super(message);
        Error.captureStackTrace(this, this.constructor);
        this.name = this.constructor.name;
        this.code = code;
        this.exitCode = exitCode;
        this.nestedError = void 0;
      }
    };
    var InvalidArgumentError2 = class extends CommanderError2 {
      /**
       * Constructs the InvalidArgumentError class
       * @param {string} [message] explanation of why argument is invalid
       */
      constructor(message) {
        super(1, "commander.invalidArgument", message);
        Error.captureStackTrace(this, this.constructor);
        this.name = this.constructor.name;
      }
    };
    exports2.CommanderError = CommanderError2;
    exports2.InvalidArgumentError = InvalidArgumentError2;
  }
});

// node_modules/commander/lib/argument.js
var require_argument = __commonJS({
  "node_modules/commander/lib/argument.js"(exports2) {
    var { InvalidArgumentError: InvalidArgumentError2 } = require_error();
    var Argument2 = class {
      /**
       * Initialize a new command argument with the given name and description.
       * The default is that the argument is required, and you can explicitly
       * indicate this with <> around the name. Put [] around the name for an optional argument.
       *
       * @param {string} name
       * @param {string} [description]
       */
      constructor(name, description) {
        this.description = description || "";
        this.variadic = false;
        this.parseArg = void 0;
        this.defaultValue = void 0;
        this.defaultValueDescription = void 0;
        this.argChoices = void 0;
        switch (name[0]) {
          case "<":
            this.required = true;
            this._name = name.slice(1, -1);
            break;
          case "[":
            this.required = false;
            this._name = name.slice(1, -1);
            break;
          default:
            this.required = true;
            this._name = name;
            break;
        }
        if (this._name.length > 3 && this._name.slice(-3) === "...") {
          this.variadic = true;
          this._name = this._name.slice(0, -3);
        }
      }
      /**
       * Return argument name.
       *
       * @return {string}
       */
      name() {
        return this._name;
      }
      /**
       * @package
       */
      _concatValue(value, previous) {
        if (previous === this.defaultValue || !Array.isArray(previous)) {
          return [value];
        }
        return previous.concat(value);
      }
      /**
       * Set the default value, and optionally supply the description to be displayed in the help.
       *
       * @param {*} value
       * @param {string} [description]
       * @return {Argument}
       */
      default(value, description) {
        this.defaultValue = value;
        this.defaultValueDescription = description;
        return this;
      }
      /**
       * Set the custom handler for processing CLI command arguments into argument values.
       *
       * @param {Function} [fn]
       * @return {Argument}
       */
      argParser(fn) {
        this.parseArg = fn;
        return this;
      }
      /**
       * Only allow argument value to be one of choices.
       *
       * @param {string[]} values
       * @return {Argument}
       */
      choices(values) {
        this.argChoices = values.slice();
        this.parseArg = (arg, previous) => {
          if (!this.argChoices.includes(arg)) {
            throw new InvalidArgumentError2(
              `Allowed choices are ${this.argChoices.join(", ")}.`
            );
          }
          if (this.variadic) {
            return this._concatValue(arg, previous);
          }
          return arg;
        };
        return this;
      }
      /**
       * Make argument required.
       *
       * @returns {Argument}
       */
      argRequired() {
        this.required = true;
        return this;
      }
      /**
       * Make argument optional.
       *
       * @returns {Argument}
       */
      argOptional() {
        this.required = false;
        return this;
      }
    };
    function humanReadableArgName(arg) {
      const nameOutput = arg.name() + (arg.variadic === true ? "..." : "");
      return arg.required ? "<" + nameOutput + ">" : "[" + nameOutput + "]";
    }
    exports2.Argument = Argument2;
    exports2.humanReadableArgName = humanReadableArgName;
  }
});

// node_modules/commander/lib/help.js
var require_help = __commonJS({
  "node_modules/commander/lib/help.js"(exports2) {
    var { humanReadableArgName } = require_argument();
    var Help2 = class {
      constructor() {
        this.helpWidth = void 0;
        this.sortSubcommands = false;
        this.sortOptions = false;
        this.showGlobalOptions = false;
      }
      /**
       * Get an array of the visible subcommands. Includes a placeholder for the implicit help command, if there is one.
       *
       * @param {Command} cmd
       * @returns {Command[]}
       */
      visibleCommands(cmd) {
        const visibleCommands = cmd.commands.filter((cmd2) => !cmd2._hidden);
        const helpCommand = cmd._getHelpCommand();
        if (helpCommand && !helpCommand._hidden) {
          visibleCommands.push(helpCommand);
        }
        if (this.sortSubcommands) {
          visibleCommands.sort((a, b) => {
            return a.name().localeCompare(b.name());
          });
        }
        return visibleCommands;
      }
      /**
       * Compare options for sort.
       *
       * @param {Option} a
       * @param {Option} b
       * @returns {number}
       */
      compareOptions(a, b) {
        const getSortKey = (option) => {
          return option.short ? option.short.replace(/^-/, "") : option.long.replace(/^--/, "");
        };
        return getSortKey(a).localeCompare(getSortKey(b));
      }
      /**
       * Get an array of the visible options. Includes a placeholder for the implicit help option, if there is one.
       *
       * @param {Command} cmd
       * @returns {Option[]}
       */
      visibleOptions(cmd) {
        const visibleOptions = cmd.options.filter((option) => !option.hidden);
        const helpOption = cmd._getHelpOption();
        if (helpOption && !helpOption.hidden) {
          const removeShort = helpOption.short && cmd._findOption(helpOption.short);
          const removeLong = helpOption.long && cmd._findOption(helpOption.long);
          if (!removeShort && !removeLong) {
            visibleOptions.push(helpOption);
          } else if (helpOption.long && !removeLong) {
            visibleOptions.push(
              cmd.createOption(helpOption.long, helpOption.description)
            );
          } else if (helpOption.short && !removeShort) {
            visibleOptions.push(
              cmd.createOption(helpOption.short, helpOption.description)
            );
          }
        }
        if (this.sortOptions) {
          visibleOptions.sort(this.compareOptions);
        }
        return visibleOptions;
      }
      /**
       * Get an array of the visible global options. (Not including help.)
       *
       * @param {Command} cmd
       * @returns {Option[]}
       */
      visibleGlobalOptions(cmd) {
        if (!this.showGlobalOptions) return [];
        const globalOptions = [];
        for (let ancestorCmd = cmd.parent; ancestorCmd; ancestorCmd = ancestorCmd.parent) {
          const visibleOptions = ancestorCmd.options.filter(
            (option) => !option.hidden
          );
          globalOptions.push(...visibleOptions);
        }
        if (this.sortOptions) {
          globalOptions.sort(this.compareOptions);
        }
        return globalOptions;
      }
      /**
       * Get an array of the arguments if any have a description.
       *
       * @param {Command} cmd
       * @returns {Argument[]}
       */
      visibleArguments(cmd) {
        if (cmd._argsDescription) {
          cmd.registeredArguments.forEach((argument) => {
            argument.description = argument.description || cmd._argsDescription[argument.name()] || "";
          });
        }
        if (cmd.registeredArguments.find((argument) => argument.description)) {
          return cmd.registeredArguments;
        }
        return [];
      }
      /**
       * Get the command term to show in the list of subcommands.
       *
       * @param {Command} cmd
       * @returns {string}
       */
      subcommandTerm(cmd) {
        const args = cmd.registeredArguments.map((arg) => humanReadableArgName(arg)).join(" ");
        return cmd._name + (cmd._aliases[0] ? "|" + cmd._aliases[0] : "") + (cmd.options.length ? " [options]" : "") + // simplistic check for non-help option
        (args ? " " + args : "");
      }
      /**
       * Get the option term to show in the list of options.
       *
       * @param {Option} option
       * @returns {string}
       */
      optionTerm(option) {
        return option.flags;
      }
      /**
       * Get the argument term to show in the list of arguments.
       *
       * @param {Argument} argument
       * @returns {string}
       */
      argumentTerm(argument) {
        return argument.name();
      }
      /**
       * Get the longest command term length.
       *
       * @param {Command} cmd
       * @param {Help} helper
       * @returns {number}
       */
      longestSubcommandTermLength(cmd, helper) {
        return helper.visibleCommands(cmd).reduce((max, command) => {
          return Math.max(max, helper.subcommandTerm(command).length);
        }, 0);
      }
      /**
       * Get the longest option term length.
       *
       * @param {Command} cmd
       * @param {Help} helper
       * @returns {number}
       */
      longestOptionTermLength(cmd, helper) {
        return helper.visibleOptions(cmd).reduce((max, option) => {
          return Math.max(max, helper.optionTerm(option).length);
        }, 0);
      }
      /**
       * Get the longest global option term length.
       *
       * @param {Command} cmd
       * @param {Help} helper
       * @returns {number}
       */
      longestGlobalOptionTermLength(cmd, helper) {
        return helper.visibleGlobalOptions(cmd).reduce((max, option) => {
          return Math.max(max, helper.optionTerm(option).length);
        }, 0);
      }
      /**
       * Get the longest argument term length.
       *
       * @param {Command} cmd
       * @param {Help} helper
       * @returns {number}
       */
      longestArgumentTermLength(cmd, helper) {
        return helper.visibleArguments(cmd).reduce((max, argument) => {
          return Math.max(max, helper.argumentTerm(argument).length);
        }, 0);
      }
      /**
       * Get the command usage to be displayed at the top of the built-in help.
       *
       * @param {Command} cmd
       * @returns {string}
       */
      commandUsage(cmd) {
        let cmdName = cmd._name;
        if (cmd._aliases[0]) {
          cmdName = cmdName + "|" + cmd._aliases[0];
        }
        let ancestorCmdNames = "";
        for (let ancestorCmd = cmd.parent; ancestorCmd; ancestorCmd = ancestorCmd.parent) {
          ancestorCmdNames = ancestorCmd.name() + " " + ancestorCmdNames;
        }
        return ancestorCmdNames + cmdName + " " + cmd.usage();
      }
      /**
       * Get the description for the command.
       *
       * @param {Command} cmd
       * @returns {string}
       */
      commandDescription(cmd) {
        return cmd.description();
      }
      /**
       * Get the subcommand summary to show in the list of subcommands.
       * (Fallback to description for backwards compatibility.)
       *
       * @param {Command} cmd
       * @returns {string}
       */
      subcommandDescription(cmd) {
        return cmd.summary() || cmd.description();
      }
      /**
       * Get the option description to show in the list of options.
       *
       * @param {Option} option
       * @return {string}
       */
      optionDescription(option) {
        const extraInfo = [];
        if (option.argChoices) {
          extraInfo.push(
            // use stringify to match the display of the default value
            `choices: ${option.argChoices.map((choice) => JSON.stringify(choice)).join(", ")}`
          );
        }
        if (option.defaultValue !== void 0) {
          const showDefault = option.required || option.optional || option.isBoolean() && typeof option.defaultValue === "boolean";
          if (showDefault) {
            extraInfo.push(
              `default: ${option.defaultValueDescription || JSON.stringify(option.defaultValue)}`
            );
          }
        }
        if (option.presetArg !== void 0 && option.optional) {
          extraInfo.push(`preset: ${JSON.stringify(option.presetArg)}`);
        }
        if (option.envVar !== void 0) {
          extraInfo.push(`env: ${option.envVar}`);
        }
        if (extraInfo.length > 0) {
          return `${option.description} (${extraInfo.join(", ")})`;
        }
        return option.description;
      }
      /**
       * Get the argument description to show in the list of arguments.
       *
       * @param {Argument} argument
       * @return {string}
       */
      argumentDescription(argument) {
        const extraInfo = [];
        if (argument.argChoices) {
          extraInfo.push(
            // use stringify to match the display of the default value
            `choices: ${argument.argChoices.map((choice) => JSON.stringify(choice)).join(", ")}`
          );
        }
        if (argument.defaultValue !== void 0) {
          extraInfo.push(
            `default: ${argument.defaultValueDescription || JSON.stringify(argument.defaultValue)}`
          );
        }
        if (extraInfo.length > 0) {
          const extraDescripton = `(${extraInfo.join(", ")})`;
          if (argument.description) {
            return `${argument.description} ${extraDescripton}`;
          }
          return extraDescripton;
        }
        return argument.description;
      }
      /**
       * Generate the built-in help text.
       *
       * @param {Command} cmd
       * @param {Help} helper
       * @returns {string}
       */
      formatHelp(cmd, helper) {
        const termWidth = helper.padWidth(cmd, helper);
        const helpWidth = helper.helpWidth || 80;
        const itemIndentWidth = 2;
        const itemSeparatorWidth = 2;
        function formatItem(term, description) {
          if (description) {
            const fullText = `${term.padEnd(termWidth + itemSeparatorWidth)}${description}`;
            return helper.wrap(
              fullText,
              helpWidth - itemIndentWidth,
              termWidth + itemSeparatorWidth
            );
          }
          return term;
        }
        function formatList(textArray) {
          return textArray.join("\n").replace(/^/gm, " ".repeat(itemIndentWidth));
        }
        let output = [`Usage: ${helper.commandUsage(cmd)}`, ""];
        const commandDescription = helper.commandDescription(cmd);
        if (commandDescription.length > 0) {
          output = output.concat([
            helper.wrap(commandDescription, helpWidth, 0),
            ""
          ]);
        }
        const argumentList = helper.visibleArguments(cmd).map((argument) => {
          return formatItem(
            helper.argumentTerm(argument),
            helper.argumentDescription(argument)
          );
        });
        if (argumentList.length > 0) {
          output = output.concat(["Arguments:", formatList(argumentList), ""]);
        }
        const optionList = helper.visibleOptions(cmd).map((option) => {
          return formatItem(
            helper.optionTerm(option),
            helper.optionDescription(option)
          );
        });
        if (optionList.length > 0) {
          output = output.concat(["Options:", formatList(optionList), ""]);
        }
        if (this.showGlobalOptions) {
          const globalOptionList = helper.visibleGlobalOptions(cmd).map((option) => {
            return formatItem(
              helper.optionTerm(option),
              helper.optionDescription(option)
            );
          });
          if (globalOptionList.length > 0) {
            output = output.concat([
              "Global Options:",
              formatList(globalOptionList),
              ""
            ]);
          }
        }
        const commandList = helper.visibleCommands(cmd).map((cmd2) => {
          return formatItem(
            helper.subcommandTerm(cmd2),
            helper.subcommandDescription(cmd2)
          );
        });
        if (commandList.length > 0) {
          output = output.concat(["Commands:", formatList(commandList), ""]);
        }
        return output.join("\n");
      }
      /**
       * Calculate the pad width from the maximum term length.
       *
       * @param {Command} cmd
       * @param {Help} helper
       * @returns {number}
       */
      padWidth(cmd, helper) {
        return Math.max(
          helper.longestOptionTermLength(cmd, helper),
          helper.longestGlobalOptionTermLength(cmd, helper),
          helper.longestSubcommandTermLength(cmd, helper),
          helper.longestArgumentTermLength(cmd, helper)
        );
      }
      /**
       * Wrap the given string to width characters per line, with lines after the first indented.
       * Do not wrap if insufficient room for wrapping (minColumnWidth), or string is manually formatted.
       *
       * @param {string} str
       * @param {number} width
       * @param {number} indent
       * @param {number} [minColumnWidth=40]
       * @return {string}
       *
       */
      wrap(str, width, indent, minColumnWidth = 40) {
        const indents = " \\f\\t\\v\xA0\u1680\u2000-\u200A\u202F\u205F\u3000\uFEFF";
        const manualIndent = new RegExp(`[\\n][${indents}]+`);
        if (str.match(manualIndent)) return str;
        const columnWidth = width - indent;
        if (columnWidth < minColumnWidth) return str;
        const leadingStr = str.slice(0, indent);
        const columnText = str.slice(indent).replace("\r\n", "\n");
        const indentString = " ".repeat(indent);
        const zeroWidthSpace = "\u200B";
        const breaks = `\\s${zeroWidthSpace}`;
        const regex = new RegExp(
          `
|.{1,${columnWidth - 1}}([${breaks}]|$)|[^${breaks}]+?([${breaks}]|$)`,
          "g"
        );
        const lines = columnText.match(regex) || [];
        return leadingStr + lines.map((line, i) => {
          if (line === "\n") return "";
          return (i > 0 ? indentString : "") + line.trimEnd();
        }).join("\n");
      }
    };
    exports2.Help = Help2;
  }
});

// node_modules/commander/lib/option.js
var require_option = __commonJS({
  "node_modules/commander/lib/option.js"(exports2) {
    var { InvalidArgumentError: InvalidArgumentError2 } = require_error();
    var Option2 = class {
      /**
       * Initialize a new `Option` with the given `flags` and `description`.
       *
       * @param {string} flags
       * @param {string} [description]
       */
      constructor(flags, description) {
        this.flags = flags;
        this.description = description || "";
        this.required = flags.includes("<");
        this.optional = flags.includes("[");
        this.variadic = /\w\.\.\.[>\]]$/.test(flags);
        this.mandatory = false;
        const optionFlags = splitOptionFlags(flags);
        this.short = optionFlags.shortFlag;
        this.long = optionFlags.longFlag;
        this.negate = false;
        if (this.long) {
          this.negate = this.long.startsWith("--no-");
        }
        this.defaultValue = void 0;
        this.defaultValueDescription = void 0;
        this.presetArg = void 0;
        this.envVar = void 0;
        this.parseArg = void 0;
        this.hidden = false;
        this.argChoices = void 0;
        this.conflictsWith = [];
        this.implied = void 0;
      }
      /**
       * Set the default value, and optionally supply the description to be displayed in the help.
       *
       * @param {*} value
       * @param {string} [description]
       * @return {Option}
       */
      default(value, description) {
        this.defaultValue = value;
        this.defaultValueDescription = description;
        return this;
      }
      /**
       * Preset to use when option used without option-argument, especially optional but also boolean and negated.
       * The custom processing (parseArg) is called.
       *
       * @example
       * new Option('--color').default('GREYSCALE').preset('RGB');
       * new Option('--donate [amount]').preset('20').argParser(parseFloat);
       *
       * @param {*} arg
       * @return {Option}
       */
      preset(arg) {
        this.presetArg = arg;
        return this;
      }
      /**
       * Add option name(s) that conflict with this option.
       * An error will be displayed if conflicting options are found during parsing.
       *
       * @example
       * new Option('--rgb').conflicts('cmyk');
       * new Option('--js').conflicts(['ts', 'jsx']);
       *
       * @param {(string | string[])} names
       * @return {Option}
       */
      conflicts(names) {
        this.conflictsWith = this.conflictsWith.concat(names);
        return this;
      }
      /**
       * Specify implied option values for when this option is set and the implied options are not.
       *
       * The custom processing (parseArg) is not called on the implied values.
       *
       * @example
       * program
       *   .addOption(new Option('--log', 'write logging information to file'))
       *   .addOption(new Option('--trace', 'log extra details').implies({ log: 'trace.txt' }));
       *
       * @param {object} impliedOptionValues
       * @return {Option}
       */
      implies(impliedOptionValues) {
        let newImplied = impliedOptionValues;
        if (typeof impliedOptionValues === "string") {
          newImplied = { [impliedOptionValues]: true };
        }
        this.implied = Object.assign(this.implied || {}, newImplied);
        return this;
      }
      /**
       * Set environment variable to check for option value.
       *
       * An environment variable is only used if when processed the current option value is
       * undefined, or the source of the current value is 'default' or 'config' or 'env'.
       *
       * @param {string} name
       * @return {Option}
       */
      env(name) {
        this.envVar = name;
        return this;
      }
      /**
       * Set the custom handler for processing CLI option arguments into option values.
       *
       * @param {Function} [fn]
       * @return {Option}
       */
      argParser(fn) {
        this.parseArg = fn;
        return this;
      }
      /**
       * Whether the option is mandatory and must have a value after parsing.
       *
       * @param {boolean} [mandatory=true]
       * @return {Option}
       */
      makeOptionMandatory(mandatory = true) {
        this.mandatory = !!mandatory;
        return this;
      }
      /**
       * Hide option in help.
       *
       * @param {boolean} [hide=true]
       * @return {Option}
       */
      hideHelp(hide = true) {
        this.hidden = !!hide;
        return this;
      }
      /**
       * @package
       */
      _concatValue(value, previous) {
        if (previous === this.defaultValue || !Array.isArray(previous)) {
          return [value];
        }
        return previous.concat(value);
      }
      /**
       * Only allow option value to be one of choices.
       *
       * @param {string[]} values
       * @return {Option}
       */
      choices(values) {
        this.argChoices = values.slice();
        this.parseArg = (arg, previous) => {
          if (!this.argChoices.includes(arg)) {
            throw new InvalidArgumentError2(
              `Allowed choices are ${this.argChoices.join(", ")}.`
            );
          }
          if (this.variadic) {
            return this._concatValue(arg, previous);
          }
          return arg;
        };
        return this;
      }
      /**
       * Return option name.
       *
       * @return {string}
       */
      name() {
        if (this.long) {
          return this.long.replace(/^--/, "");
        }
        return this.short.replace(/^-/, "");
      }
      /**
       * Return option name, in a camelcase format that can be used
       * as a object attribute key.
       *
       * @return {string}
       */
      attributeName() {
        return camelcase(this.name().replace(/^no-/, ""));
      }
      /**
       * Check if `arg` matches the short or long flag.
       *
       * @param {string} arg
       * @return {boolean}
       * @package
       */
      is(arg) {
        return this.short === arg || this.long === arg;
      }
      /**
       * Return whether a boolean option.
       *
       * Options are one of boolean, negated, required argument, or optional argument.
       *
       * @return {boolean}
       * @package
       */
      isBoolean() {
        return !this.required && !this.optional && !this.negate;
      }
    };
    var DualOptions = class {
      /**
       * @param {Option[]} options
       */
      constructor(options) {
        this.positiveOptions = /* @__PURE__ */ new Map();
        this.negativeOptions = /* @__PURE__ */ new Map();
        this.dualOptions = /* @__PURE__ */ new Set();
        options.forEach((option) => {
          if (option.negate) {
            this.negativeOptions.set(option.attributeName(), option);
          } else {
            this.positiveOptions.set(option.attributeName(), option);
          }
        });
        this.negativeOptions.forEach((value, key) => {
          if (this.positiveOptions.has(key)) {
            this.dualOptions.add(key);
          }
        });
      }
      /**
       * Did the value come from the option, and not from possible matching dual option?
       *
       * @param {*} value
       * @param {Option} option
       * @returns {boolean}
       */
      valueFromOption(value, option) {
        const optionKey = option.attributeName();
        if (!this.dualOptions.has(optionKey)) return true;
        const preset = this.negativeOptions.get(optionKey).presetArg;
        const negativeValue = preset !== void 0 ? preset : false;
        return option.negate === (negativeValue === value);
      }
    };
    function camelcase(str) {
      return str.split("-").reduce((str2, word) => {
        return str2 + word[0].toUpperCase() + word.slice(1);
      });
    }
    function splitOptionFlags(flags) {
      let shortFlag;
      let longFlag;
      const flagParts = flags.split(/[ |,]+/);
      if (flagParts.length > 1 && !/^[[<]/.test(flagParts[1]))
        shortFlag = flagParts.shift();
      longFlag = flagParts.shift();
      if (!shortFlag && /^-[^-]$/.test(longFlag)) {
        shortFlag = longFlag;
        longFlag = void 0;
      }
      return { shortFlag, longFlag };
    }
    exports2.Option = Option2;
    exports2.DualOptions = DualOptions;
  }
});

// node_modules/commander/lib/suggestSimilar.js
var require_suggestSimilar = __commonJS({
  "node_modules/commander/lib/suggestSimilar.js"(exports2) {
    var maxDistance = 3;
    function editDistance(a, b) {
      if (Math.abs(a.length - b.length) > maxDistance)
        return Math.max(a.length, b.length);
      const d = [];
      for (let i = 0; i <= a.length; i++) {
        d[i] = [i];
      }
      for (let j = 0; j <= b.length; j++) {
        d[0][j] = j;
      }
      for (let j = 1; j <= b.length; j++) {
        for (let i = 1; i <= a.length; i++) {
          let cost = 1;
          if (a[i - 1] === b[j - 1]) {
            cost = 0;
          } else {
            cost = 1;
          }
          d[i][j] = Math.min(
            d[i - 1][j] + 1,
            // deletion
            d[i][j - 1] + 1,
            // insertion
            d[i - 1][j - 1] + cost
            // substitution
          );
          if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
            d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
          }
        }
      }
      return d[a.length][b.length];
    }
    function suggestSimilar(word, candidates) {
      if (!candidates || candidates.length === 0) return "";
      candidates = Array.from(new Set(candidates));
      const searchingOptions = word.startsWith("--");
      if (searchingOptions) {
        word = word.slice(2);
        candidates = candidates.map((candidate) => candidate.slice(2));
      }
      let similar = [];
      let bestDistance = maxDistance;
      const minSimilarity = 0.4;
      candidates.forEach((candidate) => {
        if (candidate.length <= 1) return;
        const distance = editDistance(word, candidate);
        const length = Math.max(word.length, candidate.length);
        const similarity = (length - distance) / length;
        if (similarity > minSimilarity) {
          if (distance < bestDistance) {
            bestDistance = distance;
            similar = [candidate];
          } else if (distance === bestDistance) {
            similar.push(candidate);
          }
        }
      });
      similar.sort((a, b) => a.localeCompare(b));
      if (searchingOptions) {
        similar = similar.map((candidate) => `--${candidate}`);
      }
      if (similar.length > 1) {
        return `
(Did you mean one of ${similar.join(", ")}?)`;
      }
      if (similar.length === 1) {
        return `
(Did you mean ${similar[0]}?)`;
      }
      return "";
    }
    exports2.suggestSimilar = suggestSimilar;
  }
});

// node_modules/commander/lib/command.js
var require_command = __commonJS({
  "node_modules/commander/lib/command.js"(exports2) {
    var EventEmitter = require("node:events").EventEmitter;
    var childProcess = require("node:child_process");
    var path = require("node:path");
    var fs = require("node:fs");
    var process2 = require("node:process");
    var { Argument: Argument2, humanReadableArgName } = require_argument();
    var { CommanderError: CommanderError2 } = require_error();
    var { Help: Help2 } = require_help();
    var { Option: Option2, DualOptions } = require_option();
    var { suggestSimilar } = require_suggestSimilar();
    var Command2 = class _Command extends EventEmitter {
      /**
       * Initialize a new `Command`.
       *
       * @param {string} [name]
       */
      constructor(name) {
        super();
        this.commands = [];
        this.options = [];
        this.parent = null;
        this._allowUnknownOption = false;
        this._allowExcessArguments = true;
        this.registeredArguments = [];
        this._args = this.registeredArguments;
        this.args = [];
        this.rawArgs = [];
        this.processedArgs = [];
        this._scriptPath = null;
        this._name = name || "";
        this._optionValues = {};
        this._optionValueSources = {};
        this._storeOptionsAsProperties = false;
        this._actionHandler = null;
        this._executableHandler = false;
        this._executableFile = null;
        this._executableDir = null;
        this._defaultCommandName = null;
        this._exitCallback = null;
        this._aliases = [];
        this._combineFlagAndOptionalValue = true;
        this._description = "";
        this._summary = "";
        this._argsDescription = void 0;
        this._enablePositionalOptions = false;
        this._passThroughOptions = false;
        this._lifeCycleHooks = {};
        this._showHelpAfterError = false;
        this._showSuggestionAfterError = true;
        this._outputConfiguration = {
          writeOut: (str) => process2.stdout.write(str),
          writeErr: (str) => process2.stderr.write(str),
          getOutHelpWidth: () => process2.stdout.isTTY ? process2.stdout.columns : void 0,
          getErrHelpWidth: () => process2.stderr.isTTY ? process2.stderr.columns : void 0,
          outputError: (str, write) => write(str)
        };
        this._hidden = false;
        this._helpOption = void 0;
        this._addImplicitHelpCommand = void 0;
        this._helpCommand = void 0;
        this._helpConfiguration = {};
      }
      /**
       * Copy settings that are useful to have in common across root command and subcommands.
       *
       * (Used internally when adding a command using `.command()` so subcommands inherit parent settings.)
       *
       * @param {Command} sourceCommand
       * @return {Command} `this` command for chaining
       */
      copyInheritedSettings(sourceCommand) {
        this._outputConfiguration = sourceCommand._outputConfiguration;
        this._helpOption = sourceCommand._helpOption;
        this._helpCommand = sourceCommand._helpCommand;
        this._helpConfiguration = sourceCommand._helpConfiguration;
        this._exitCallback = sourceCommand._exitCallback;
        this._storeOptionsAsProperties = sourceCommand._storeOptionsAsProperties;
        this._combineFlagAndOptionalValue = sourceCommand._combineFlagAndOptionalValue;
        this._allowExcessArguments = sourceCommand._allowExcessArguments;
        this._enablePositionalOptions = sourceCommand._enablePositionalOptions;
        this._showHelpAfterError = sourceCommand._showHelpAfterError;
        this._showSuggestionAfterError = sourceCommand._showSuggestionAfterError;
        return this;
      }
      /**
       * @returns {Command[]}
       * @private
       */
      _getCommandAndAncestors() {
        const result = [];
        for (let command = this; command; command = command.parent) {
          result.push(command);
        }
        return result;
      }
      /**
       * Define a command.
       *
       * There are two styles of command: pay attention to where to put the description.
       *
       * @example
       * // Command implemented using action handler (description is supplied separately to `.command`)
       * program
       *   .command('clone <source> [destination]')
       *   .description('clone a repository into a newly created directory')
       *   .action((source, destination) => {
       *     console.log('clone command called');
       *   });
       *
       * // Command implemented using separate executable file (description is second parameter to `.command`)
       * program
       *   .command('start <service>', 'start named service')
       *   .command('stop [service]', 'stop named service, or all if no name supplied');
       *
       * @param {string} nameAndArgs - command name and arguments, args are `<required>` or `[optional]` and last may also be `variadic...`
       * @param {(object | string)} [actionOptsOrExecDesc] - configuration options (for action), or description (for executable)
       * @param {object} [execOpts] - configuration options (for executable)
       * @return {Command} returns new command for action handler, or `this` for executable command
       */
      command(nameAndArgs, actionOptsOrExecDesc, execOpts) {
        let desc = actionOptsOrExecDesc;
        let opts = execOpts;
        if (typeof desc === "object" && desc !== null) {
          opts = desc;
          desc = null;
        }
        opts = opts || {};
        const [, name, args] = nameAndArgs.match(/([^ ]+) *(.*)/);
        const cmd = this.createCommand(name);
        if (desc) {
          cmd.description(desc);
          cmd._executableHandler = true;
        }
        if (opts.isDefault) this._defaultCommandName = cmd._name;
        cmd._hidden = !!(opts.noHelp || opts.hidden);
        cmd._executableFile = opts.executableFile || null;
        if (args) cmd.arguments(args);
        this._registerCommand(cmd);
        cmd.parent = this;
        cmd.copyInheritedSettings(this);
        if (desc) return this;
        return cmd;
      }
      /**
       * Factory routine to create a new unattached command.
       *
       * See .command() for creating an attached subcommand, which uses this routine to
       * create the command. You can override createCommand to customise subcommands.
       *
       * @param {string} [name]
       * @return {Command} new command
       */
      createCommand(name) {
        return new _Command(name);
      }
      /**
       * You can customise the help with a subclass of Help by overriding createHelp,
       * or by overriding Help properties using configureHelp().
       *
       * @return {Help}
       */
      createHelp() {
        return Object.assign(new Help2(), this.configureHelp());
      }
      /**
       * You can customise the help by overriding Help properties using configureHelp(),
       * or with a subclass of Help by overriding createHelp().
       *
       * @param {object} [configuration] - configuration options
       * @return {(Command | object)} `this` command for chaining, or stored configuration
       */
      configureHelp(configuration) {
        if (configuration === void 0) return this._helpConfiguration;
        this._helpConfiguration = configuration;
        return this;
      }
      /**
       * The default output goes to stdout and stderr. You can customise this for special
       * applications. You can also customise the display of errors by overriding outputError.
       *
       * The configuration properties are all functions:
       *
       *     // functions to change where being written, stdout and stderr
       *     writeOut(str)
       *     writeErr(str)
       *     // matching functions to specify width for wrapping help
       *     getOutHelpWidth()
       *     getErrHelpWidth()
       *     // functions based on what is being written out
       *     outputError(str, write) // used for displaying errors, and not used for displaying help
       *
       * @param {object} [configuration] - configuration options
       * @return {(Command | object)} `this` command for chaining, or stored configuration
       */
      configureOutput(configuration) {
        if (configuration === void 0) return this._outputConfiguration;
        Object.assign(this._outputConfiguration, configuration);
        return this;
      }
      /**
       * Display the help or a custom message after an error occurs.
       *
       * @param {(boolean|string)} [displayHelp]
       * @return {Command} `this` command for chaining
       */
      showHelpAfterError(displayHelp = true) {
        if (typeof displayHelp !== "string") displayHelp = !!displayHelp;
        this._showHelpAfterError = displayHelp;
        return this;
      }
      /**
       * Display suggestion of similar commands for unknown commands, or options for unknown options.
       *
       * @param {boolean} [displaySuggestion]
       * @return {Command} `this` command for chaining
       */
      showSuggestionAfterError(displaySuggestion = true) {
        this._showSuggestionAfterError = !!displaySuggestion;
        return this;
      }
      /**
       * Add a prepared subcommand.
       *
       * See .command() for creating an attached subcommand which inherits settings from its parent.
       *
       * @param {Command} cmd - new subcommand
       * @param {object} [opts] - configuration options
       * @return {Command} `this` command for chaining
       */
      addCommand(cmd, opts) {
        if (!cmd._name) {
          throw new Error(`Command passed to .addCommand() must have a name
- specify the name in Command constructor or using .name()`);
        }
        opts = opts || {};
        if (opts.isDefault) this._defaultCommandName = cmd._name;
        if (opts.noHelp || opts.hidden) cmd._hidden = true;
        this._registerCommand(cmd);
        cmd.parent = this;
        cmd._checkForBrokenPassThrough();
        return this;
      }
      /**
       * Factory routine to create a new unattached argument.
       *
       * See .argument() for creating an attached argument, which uses this routine to
       * create the argument. You can override createArgument to return a custom argument.
       *
       * @param {string} name
       * @param {string} [description]
       * @return {Argument} new argument
       */
      createArgument(name, description) {
        return new Argument2(name, description);
      }
      /**
       * Define argument syntax for command.
       *
       * The default is that the argument is required, and you can explicitly
       * indicate this with <> around the name. Put [] around the name for an optional argument.
       *
       * @example
       * program.argument('<input-file>');
       * program.argument('[output-file]');
       *
       * @param {string} name
       * @param {string} [description]
       * @param {(Function|*)} [fn] - custom argument processing function
       * @param {*} [defaultValue]
       * @return {Command} `this` command for chaining
       */
      argument(name, description, fn, defaultValue) {
        const argument = this.createArgument(name, description);
        if (typeof fn === "function") {
          argument.default(defaultValue).argParser(fn);
        } else {
          argument.default(fn);
        }
        this.addArgument(argument);
        return this;
      }
      /**
       * Define argument syntax for command, adding multiple at once (without descriptions).
       *
       * See also .argument().
       *
       * @example
       * program.arguments('<cmd> [env]');
       *
       * @param {string} names
       * @return {Command} `this` command for chaining
       */
      arguments(names) {
        names.trim().split(/ +/).forEach((detail) => {
          this.argument(detail);
        });
        return this;
      }
      /**
       * Define argument syntax for command, adding a prepared argument.
       *
       * @param {Argument} argument
       * @return {Command} `this` command for chaining
       */
      addArgument(argument) {
        const previousArgument = this.registeredArguments.slice(-1)[0];
        if (previousArgument && previousArgument.variadic) {
          throw new Error(
            `only the last argument can be variadic '${previousArgument.name()}'`
          );
        }
        if (argument.required && argument.defaultValue !== void 0 && argument.parseArg === void 0) {
          throw new Error(
            `a default value for a required argument is never used: '${argument.name()}'`
          );
        }
        this.registeredArguments.push(argument);
        return this;
      }
      /**
       * Customise or override default help command. By default a help command is automatically added if your command has subcommands.
       *
       * @example
       *    program.helpCommand('help [cmd]');
       *    program.helpCommand('help [cmd]', 'show help');
       *    program.helpCommand(false); // suppress default help command
       *    program.helpCommand(true); // add help command even if no subcommands
       *
       * @param {string|boolean} enableOrNameAndArgs - enable with custom name and/or arguments, or boolean to override whether added
       * @param {string} [description] - custom description
       * @return {Command} `this` command for chaining
       */
      helpCommand(enableOrNameAndArgs, description) {
        if (typeof enableOrNameAndArgs === "boolean") {
          this._addImplicitHelpCommand = enableOrNameAndArgs;
          return this;
        }
        enableOrNameAndArgs = enableOrNameAndArgs ?? "help [command]";
        const [, helpName, helpArgs] = enableOrNameAndArgs.match(/([^ ]+) *(.*)/);
        const helpDescription = description ?? "display help for command";
        const helpCommand = this.createCommand(helpName);
        helpCommand.helpOption(false);
        if (helpArgs) helpCommand.arguments(helpArgs);
        if (helpDescription) helpCommand.description(helpDescription);
        this._addImplicitHelpCommand = true;
        this._helpCommand = helpCommand;
        return this;
      }
      /**
       * Add prepared custom help command.
       *
       * @param {(Command|string|boolean)} helpCommand - custom help command, or deprecated enableOrNameAndArgs as for `.helpCommand()`
       * @param {string} [deprecatedDescription] - deprecated custom description used with custom name only
       * @return {Command} `this` command for chaining
       */
      addHelpCommand(helpCommand, deprecatedDescription) {
        if (typeof helpCommand !== "object") {
          this.helpCommand(helpCommand, deprecatedDescription);
          return this;
        }
        this._addImplicitHelpCommand = true;
        this._helpCommand = helpCommand;
        return this;
      }
      /**
       * Lazy create help command.
       *
       * @return {(Command|null)}
       * @package
       */
      _getHelpCommand() {
        const hasImplicitHelpCommand = this._addImplicitHelpCommand ?? (this.commands.length && !this._actionHandler && !this._findCommand("help"));
        if (hasImplicitHelpCommand) {
          if (this._helpCommand === void 0) {
            this.helpCommand(void 0, void 0);
          }
          return this._helpCommand;
        }
        return null;
      }
      /**
       * Add hook for life cycle event.
       *
       * @param {string} event
       * @param {Function} listener
       * @return {Command} `this` command for chaining
       */
      hook(event, listener) {
        const allowedValues = ["preSubcommand", "preAction", "postAction"];
        if (!allowedValues.includes(event)) {
          throw new Error(`Unexpected value for event passed to hook : '${event}'.
Expecting one of '${allowedValues.join("', '")}'`);
        }
        if (this._lifeCycleHooks[event]) {
          this._lifeCycleHooks[event].push(listener);
        } else {
          this._lifeCycleHooks[event] = [listener];
        }
        return this;
      }
      /**
       * Register callback to use as replacement for calling process.exit.
       *
       * @param {Function} [fn] optional callback which will be passed a CommanderError, defaults to throwing
       * @return {Command} `this` command for chaining
       */
      exitOverride(fn) {
        if (fn) {
          this._exitCallback = fn;
        } else {
          this._exitCallback = (err) => {
            if (err.code !== "commander.executeSubCommandAsync") {
              throw err;
            } else {
            }
          };
        }
        return this;
      }
      /**
       * Call process.exit, and _exitCallback if defined.
       *
       * @param {number} exitCode exit code for using with process.exit
       * @param {string} code an id string representing the error
       * @param {string} message human-readable description of the error
       * @return never
       * @private
       */
      _exit(exitCode, code, message) {
        if (this._exitCallback) {
          this._exitCallback(new CommanderError2(exitCode, code, message));
        }
        process2.exit(exitCode);
      }
      /**
       * Register callback `fn` for the command.
       *
       * @example
       * program
       *   .command('serve')
       *   .description('start service')
       *   .action(function() {
       *      // do work here
       *   });
       *
       * @param {Function} fn
       * @return {Command} `this` command for chaining
       */
      action(fn) {
        const listener = (args) => {
          const expectedArgsCount = this.registeredArguments.length;
          const actionArgs = args.slice(0, expectedArgsCount);
          if (this._storeOptionsAsProperties) {
            actionArgs[expectedArgsCount] = this;
          } else {
            actionArgs[expectedArgsCount] = this.opts();
          }
          actionArgs.push(this);
          return fn.apply(this, actionArgs);
        };
        this._actionHandler = listener;
        return this;
      }
      /**
       * Factory routine to create a new unattached option.
       *
       * See .option() for creating an attached option, which uses this routine to
       * create the option. You can override createOption to return a custom option.
       *
       * @param {string} flags
       * @param {string} [description]
       * @return {Option} new option
       */
      createOption(flags, description) {
        return new Option2(flags, description);
      }
      /**
       * Wrap parseArgs to catch 'commander.invalidArgument'.
       *
       * @param {(Option | Argument)} target
       * @param {string} value
       * @param {*} previous
       * @param {string} invalidArgumentMessage
       * @private
       */
      _callParseArg(target, value, previous, invalidArgumentMessage) {
        try {
          return target.parseArg(value, previous);
        } catch (err) {
          if (err.code === "commander.invalidArgument") {
            const message = `${invalidArgumentMessage} ${err.message}`;
            this.error(message, { exitCode: err.exitCode, code: err.code });
          }
          throw err;
        }
      }
      /**
       * Check for option flag conflicts.
       * Register option if no conflicts found, or throw on conflict.
       *
       * @param {Option} option
       * @private
       */
      _registerOption(option) {
        const matchingOption = option.short && this._findOption(option.short) || option.long && this._findOption(option.long);
        if (matchingOption) {
          const matchingFlag = option.long && this._findOption(option.long) ? option.long : option.short;
          throw new Error(`Cannot add option '${option.flags}'${this._name && ` to command '${this._name}'`} due to conflicting flag '${matchingFlag}'
-  already used by option '${matchingOption.flags}'`);
        }
        this.options.push(option);
      }
      /**
       * Check for command name and alias conflicts with existing commands.
       * Register command if no conflicts found, or throw on conflict.
       *
       * @param {Command} command
       * @private
       */
      _registerCommand(command) {
        const knownBy = (cmd) => {
          return [cmd.name()].concat(cmd.aliases());
        };
        const alreadyUsed = knownBy(command).find(
          (name) => this._findCommand(name)
        );
        if (alreadyUsed) {
          const existingCmd = knownBy(this._findCommand(alreadyUsed)).join("|");
          const newCmd = knownBy(command).join("|");
          throw new Error(
            `cannot add command '${newCmd}' as already have command '${existingCmd}'`
          );
        }
        this.commands.push(command);
      }
      /**
       * Add an option.
       *
       * @param {Option} option
       * @return {Command} `this` command for chaining
       */
      addOption(option) {
        this._registerOption(option);
        const oname = option.name();
        const name = option.attributeName();
        if (option.negate) {
          const positiveLongFlag = option.long.replace(/^--no-/, "--");
          if (!this._findOption(positiveLongFlag)) {
            this.setOptionValueWithSource(
              name,
              option.defaultValue === void 0 ? true : option.defaultValue,
              "default"
            );
          }
        } else if (option.defaultValue !== void 0) {
          this.setOptionValueWithSource(name, option.defaultValue, "default");
        }
        const handleOptionValue = (val, invalidValueMessage, valueSource) => {
          if (val == null && option.presetArg !== void 0) {
            val = option.presetArg;
          }
          const oldValue = this.getOptionValue(name);
          if (val !== null && option.parseArg) {
            val = this._callParseArg(option, val, oldValue, invalidValueMessage);
          } else if (val !== null && option.variadic) {
            val = option._concatValue(val, oldValue);
          }
          if (val == null) {
            if (option.negate) {
              val = false;
            } else if (option.isBoolean() || option.optional) {
              val = true;
            } else {
              val = "";
            }
          }
          this.setOptionValueWithSource(name, val, valueSource);
        };
        this.on("option:" + oname, (val) => {
          const invalidValueMessage = `error: option '${option.flags}' argument '${val}' is invalid.`;
          handleOptionValue(val, invalidValueMessage, "cli");
        });
        if (option.envVar) {
          this.on("optionEnv:" + oname, (val) => {
            const invalidValueMessage = `error: option '${option.flags}' value '${val}' from env '${option.envVar}' is invalid.`;
            handleOptionValue(val, invalidValueMessage, "env");
          });
        }
        return this;
      }
      /**
       * Internal implementation shared by .option() and .requiredOption()
       *
       * @return {Command} `this` command for chaining
       * @private
       */
      _optionEx(config, flags, description, fn, defaultValue) {
        if (typeof flags === "object" && flags instanceof Option2) {
          throw new Error(
            "To add an Option object use addOption() instead of option() or requiredOption()"
          );
        }
        const option = this.createOption(flags, description);
        option.makeOptionMandatory(!!config.mandatory);
        if (typeof fn === "function") {
          option.default(defaultValue).argParser(fn);
        } else if (fn instanceof RegExp) {
          const regex = fn;
          fn = (val, def) => {
            const m = regex.exec(val);
            return m ? m[0] : def;
          };
          option.default(defaultValue).argParser(fn);
        } else {
          option.default(fn);
        }
        return this.addOption(option);
      }
      /**
       * Define option with `flags`, `description`, and optional argument parsing function or `defaultValue` or both.
       *
       * The `flags` string contains the short and/or long flags, separated by comma, a pipe or space. A required
       * option-argument is indicated by `<>` and an optional option-argument by `[]`.
       *
       * See the README for more details, and see also addOption() and requiredOption().
       *
       * @example
       * program
       *     .option('-p, --pepper', 'add pepper')
       *     .option('-p, --pizza-type <TYPE>', 'type of pizza') // required option-argument
       *     .option('-c, --cheese [CHEESE]', 'add extra cheese', 'mozzarella') // optional option-argument with default
       *     .option('-t, --tip <VALUE>', 'add tip to purchase cost', parseFloat) // custom parse function
       *
       * @param {string} flags
       * @param {string} [description]
       * @param {(Function|*)} [parseArg] - custom option processing function or default value
       * @param {*} [defaultValue]
       * @return {Command} `this` command for chaining
       */
      option(flags, description, parseArg, defaultValue) {
        return this._optionEx({}, flags, description, parseArg, defaultValue);
      }
      /**
       * Add a required option which must have a value after parsing. This usually means
       * the option must be specified on the command line. (Otherwise the same as .option().)
       *
       * The `flags` string contains the short and/or long flags, separated by comma, a pipe or space.
       *
       * @param {string} flags
       * @param {string} [description]
       * @param {(Function|*)} [parseArg] - custom option processing function or default value
       * @param {*} [defaultValue]
       * @return {Command} `this` command for chaining
       */
      requiredOption(flags, description, parseArg, defaultValue) {
        return this._optionEx(
          { mandatory: true },
          flags,
          description,
          parseArg,
          defaultValue
        );
      }
      /**
       * Alter parsing of short flags with optional values.
       *
       * @example
       * // for `.option('-f,--flag [value]'):
       * program.combineFlagAndOptionalValue(true);  // `-f80` is treated like `--flag=80`, this is the default behaviour
       * program.combineFlagAndOptionalValue(false) // `-fb` is treated like `-f -b`
       *
       * @param {boolean} [combine] - if `true` or omitted, an optional value can be specified directly after the flag.
       * @return {Command} `this` command for chaining
       */
      combineFlagAndOptionalValue(combine = true) {
        this._combineFlagAndOptionalValue = !!combine;
        return this;
      }
      /**
       * Allow unknown options on the command line.
       *
       * @param {boolean} [allowUnknown] - if `true` or omitted, no error will be thrown for unknown options.
       * @return {Command} `this` command for chaining
       */
      allowUnknownOption(allowUnknown = true) {
        this._allowUnknownOption = !!allowUnknown;
        return this;
      }
      /**
       * Allow excess command-arguments on the command line. Pass false to make excess arguments an error.
       *
       * @param {boolean} [allowExcess] - if `true` or omitted, no error will be thrown for excess arguments.
       * @return {Command} `this` command for chaining
       */
      allowExcessArguments(allowExcess = true) {
        this._allowExcessArguments = !!allowExcess;
        return this;
      }
      /**
       * Enable positional options. Positional means global options are specified before subcommands which lets
       * subcommands reuse the same option names, and also enables subcommands to turn on passThroughOptions.
       * The default behaviour is non-positional and global options may appear anywhere on the command line.
       *
       * @param {boolean} [positional]
       * @return {Command} `this` command for chaining
       */
      enablePositionalOptions(positional = true) {
        this._enablePositionalOptions = !!positional;
        return this;
      }
      /**
       * Pass through options that come after command-arguments rather than treat them as command-options,
       * so actual command-options come before command-arguments. Turning this on for a subcommand requires
       * positional options to have been enabled on the program (parent commands).
       * The default behaviour is non-positional and options may appear before or after command-arguments.
       *
       * @param {boolean} [passThrough] for unknown options.
       * @return {Command} `this` command for chaining
       */
      passThroughOptions(passThrough = true) {
        this._passThroughOptions = !!passThrough;
        this._checkForBrokenPassThrough();
        return this;
      }
      /**
       * @private
       */
      _checkForBrokenPassThrough() {
        if (this.parent && this._passThroughOptions && !this.parent._enablePositionalOptions) {
          throw new Error(
            `passThroughOptions cannot be used for '${this._name}' without turning on enablePositionalOptions for parent command(s)`
          );
        }
      }
      /**
       * Whether to store option values as properties on command object,
       * or store separately (specify false). In both cases the option values can be accessed using .opts().
       *
       * @param {boolean} [storeAsProperties=true]
       * @return {Command} `this` command for chaining
       */
      storeOptionsAsProperties(storeAsProperties = true) {
        if (this.options.length) {
          throw new Error("call .storeOptionsAsProperties() before adding options");
        }
        if (Object.keys(this._optionValues).length) {
          throw new Error(
            "call .storeOptionsAsProperties() before setting option values"
          );
        }
        this._storeOptionsAsProperties = !!storeAsProperties;
        return this;
      }
      /**
       * Retrieve option value.
       *
       * @param {string} key
       * @return {object} value
       */
      getOptionValue(key) {
        if (this._storeOptionsAsProperties) {
          return this[key];
        }
        return this._optionValues[key];
      }
      /**
       * Store option value.
       *
       * @param {string} key
       * @param {object} value
       * @return {Command} `this` command for chaining
       */
      setOptionValue(key, value) {
        return this.setOptionValueWithSource(key, value, void 0);
      }
      /**
       * Store option value and where the value came from.
       *
       * @param {string} key
       * @param {object} value
       * @param {string} source - expected values are default/config/env/cli/implied
       * @return {Command} `this` command for chaining
       */
      setOptionValueWithSource(key, value, source) {
        if (this._storeOptionsAsProperties) {
          this[key] = value;
        } else {
          this._optionValues[key] = value;
        }
        this._optionValueSources[key] = source;
        return this;
      }
      /**
       * Get source of option value.
       * Expected values are default | config | env | cli | implied
       *
       * @param {string} key
       * @return {string}
       */
      getOptionValueSource(key) {
        return this._optionValueSources[key];
      }
      /**
       * Get source of option value. See also .optsWithGlobals().
       * Expected values are default | config | env | cli | implied
       *
       * @param {string} key
       * @return {string}
       */
      getOptionValueSourceWithGlobals(key) {
        let source;
        this._getCommandAndAncestors().forEach((cmd) => {
          if (cmd.getOptionValueSource(key) !== void 0) {
            source = cmd.getOptionValueSource(key);
          }
        });
        return source;
      }
      /**
       * Get user arguments from implied or explicit arguments.
       * Side-effects: set _scriptPath if args included script. Used for default program name, and subcommand searches.
       *
       * @private
       */
      _prepareUserArgs(argv, parseOptions) {
        if (argv !== void 0 && !Array.isArray(argv)) {
          throw new Error("first parameter to parse must be array or undefined");
        }
        parseOptions = parseOptions || {};
        if (argv === void 0 && parseOptions.from === void 0) {
          if (process2.versions?.electron) {
            parseOptions.from = "electron";
          }
          const execArgv = process2.execArgv ?? [];
          if (execArgv.includes("-e") || execArgv.includes("--eval") || execArgv.includes("-p") || execArgv.includes("--print")) {
            parseOptions.from = "eval";
          }
        }
        if (argv === void 0) {
          argv = process2.argv;
        }
        this.rawArgs = argv.slice();
        let userArgs;
        switch (parseOptions.from) {
          case void 0:
          case "node":
            this._scriptPath = argv[1];
            userArgs = argv.slice(2);
            break;
          case "electron":
            if (process2.defaultApp) {
              this._scriptPath = argv[1];
              userArgs = argv.slice(2);
            } else {
              userArgs = argv.slice(1);
            }
            break;
          case "user":
            userArgs = argv.slice(0);
            break;
          case "eval":
            userArgs = argv.slice(1);
            break;
          default:
            throw new Error(
              `unexpected parse option { from: '${parseOptions.from}' }`
            );
        }
        if (!this._name && this._scriptPath)
          this.nameFromFilename(this._scriptPath);
        this._name = this._name || "program";
        return userArgs;
      }
      /**
       * Parse `argv`, setting options and invoking commands when defined.
       *
       * Use parseAsync instead of parse if any of your action handlers are async.
       *
       * Call with no parameters to parse `process.argv`. Detects Electron and special node options like `node --eval`. Easy mode!
       *
       * Or call with an array of strings to parse, and optionally where the user arguments start by specifying where the arguments are `from`:
       * - `'node'`: default, `argv[0]` is the application and `argv[1]` is the script being run, with user arguments after that
       * - `'electron'`: `argv[0]` is the application and `argv[1]` varies depending on whether the electron application is packaged
       * - `'user'`: just user arguments
       *
       * @example
       * program.parse(); // parse process.argv and auto-detect electron and special node flags
       * program.parse(process.argv); // assume argv[0] is app and argv[1] is script
       * program.parse(my-args, { from: 'user' }); // just user supplied arguments, nothing special about argv[0]
       *
       * @param {string[]} [argv] - optional, defaults to process.argv
       * @param {object} [parseOptions] - optionally specify style of options with from: node/user/electron
       * @param {string} [parseOptions.from] - where the args are from: 'node', 'user', 'electron'
       * @return {Command} `this` command for chaining
       */
      parse(argv, parseOptions) {
        const userArgs = this._prepareUserArgs(argv, parseOptions);
        this._parseCommand([], userArgs);
        return this;
      }
      /**
       * Parse `argv`, setting options and invoking commands when defined.
       *
       * Call with no parameters to parse `process.argv`. Detects Electron and special node options like `node --eval`. Easy mode!
       *
       * Or call with an array of strings to parse, and optionally where the user arguments start by specifying where the arguments are `from`:
       * - `'node'`: default, `argv[0]` is the application and `argv[1]` is the script being run, with user arguments after that
       * - `'electron'`: `argv[0]` is the application and `argv[1]` varies depending on whether the electron application is packaged
       * - `'user'`: just user arguments
       *
       * @example
       * await program.parseAsync(); // parse process.argv and auto-detect electron and special node flags
       * await program.parseAsync(process.argv); // assume argv[0] is app and argv[1] is script
       * await program.parseAsync(my-args, { from: 'user' }); // just user supplied arguments, nothing special about argv[0]
       *
       * @param {string[]} [argv]
       * @param {object} [parseOptions]
       * @param {string} parseOptions.from - where the args are from: 'node', 'user', 'electron'
       * @return {Promise}
       */
      async parseAsync(argv, parseOptions) {
        const userArgs = this._prepareUserArgs(argv, parseOptions);
        await this._parseCommand([], userArgs);
        return this;
      }
      /**
       * Execute a sub-command executable.
       *
       * @private
       */
      _executeSubCommand(subcommand, args) {
        args = args.slice();
        let launchWithNode = false;
        const sourceExt = [".js", ".ts", ".tsx", ".mjs", ".cjs"];
        function findFile(baseDir, baseName) {
          const localBin = path.resolve(baseDir, baseName);
          if (fs.existsSync(localBin)) return localBin;
          if (sourceExt.includes(path.extname(baseName))) return void 0;
          const foundExt = sourceExt.find(
            (ext) => fs.existsSync(`${localBin}${ext}`)
          );
          if (foundExt) return `${localBin}${foundExt}`;
          return void 0;
        }
        this._checkForMissingMandatoryOptions();
        this._checkForConflictingOptions();
        let executableFile = subcommand._executableFile || `${this._name}-${subcommand._name}`;
        let executableDir = this._executableDir || "";
        if (this._scriptPath) {
          let resolvedScriptPath;
          try {
            resolvedScriptPath = fs.realpathSync(this._scriptPath);
          } catch (err) {
            resolvedScriptPath = this._scriptPath;
          }
          executableDir = path.resolve(
            path.dirname(resolvedScriptPath),
            executableDir
          );
        }
        if (executableDir) {
          let localFile = findFile(executableDir, executableFile);
          if (!localFile && !subcommand._executableFile && this._scriptPath) {
            const legacyName = path.basename(
              this._scriptPath,
              path.extname(this._scriptPath)
            );
            if (legacyName !== this._name) {
              localFile = findFile(
                executableDir,
                `${legacyName}-${subcommand._name}`
              );
            }
          }
          executableFile = localFile || executableFile;
        }
        launchWithNode = sourceExt.includes(path.extname(executableFile));
        let proc;
        if (process2.platform !== "win32") {
          if (launchWithNode) {
            args.unshift(executableFile);
            args = incrementNodeInspectorPort(process2.execArgv).concat(args);
            proc = childProcess.spawn(process2.argv[0], args, { stdio: "inherit" });
          } else {
            proc = childProcess.spawn(executableFile, args, { stdio: "inherit" });
          }
        } else {
          args.unshift(executableFile);
          args = incrementNodeInspectorPort(process2.execArgv).concat(args);
          proc = childProcess.spawn(process2.execPath, args, { stdio: "inherit" });
        }
        if (!proc.killed) {
          const signals = ["SIGUSR1", "SIGUSR2", "SIGTERM", "SIGINT", "SIGHUP"];
          signals.forEach((signal) => {
            process2.on(signal, () => {
              if (proc.killed === false && proc.exitCode === null) {
                proc.kill(signal);
              }
            });
          });
        }
        const exitCallback = this._exitCallback;
        proc.on("close", (code) => {
          code = code ?? 1;
          if (!exitCallback) {
            process2.exit(code);
          } else {
            exitCallback(
              new CommanderError2(
                code,
                "commander.executeSubCommandAsync",
                "(close)"
              )
            );
          }
        });
        proc.on("error", (err) => {
          if (err.code === "ENOENT") {
            const executableDirMessage = executableDir ? `searched for local subcommand relative to directory '${executableDir}'` : "no directory for search for local subcommand, use .executableDir() to supply a custom directory";
            const executableMissing = `'${executableFile}' does not exist
 - if '${subcommand._name}' is not meant to be an executable command, remove description parameter from '.command()' and use '.description()' instead
 - if the default executable name is not suitable, use the executableFile option to supply a custom name or path
 - ${executableDirMessage}`;
            throw new Error(executableMissing);
          } else if (err.code === "EACCES") {
            throw new Error(`'${executableFile}' not executable`);
          }
          if (!exitCallback) {
            process2.exit(1);
          } else {
            const wrappedError = new CommanderError2(
              1,
              "commander.executeSubCommandAsync",
              "(error)"
            );
            wrappedError.nestedError = err;
            exitCallback(wrappedError);
          }
        });
        this.runningCommand = proc;
      }
      /**
       * @private
       */
      _dispatchSubcommand(commandName, operands, unknown) {
        const subCommand = this._findCommand(commandName);
        if (!subCommand) this.help({ error: true });
        let promiseChain;
        promiseChain = this._chainOrCallSubCommandHook(
          promiseChain,
          subCommand,
          "preSubcommand"
        );
        promiseChain = this._chainOrCall(promiseChain, () => {
          if (subCommand._executableHandler) {
            this._executeSubCommand(subCommand, operands.concat(unknown));
          } else {
            return subCommand._parseCommand(operands, unknown);
          }
        });
        return promiseChain;
      }
      /**
       * Invoke help directly if possible, or dispatch if necessary.
       * e.g. help foo
       *
       * @private
       */
      _dispatchHelpCommand(subcommandName) {
        if (!subcommandName) {
          this.help();
        }
        const subCommand = this._findCommand(subcommandName);
        if (subCommand && !subCommand._executableHandler) {
          subCommand.help();
        }
        return this._dispatchSubcommand(
          subcommandName,
          [],
          [this._getHelpOption()?.long ?? this._getHelpOption()?.short ?? "--help"]
        );
      }
      /**
       * Check this.args against expected this.registeredArguments.
       *
       * @private
       */
      _checkNumberOfArguments() {
        this.registeredArguments.forEach((arg, i) => {
          if (arg.required && this.args[i] == null) {
            this.missingArgument(arg.name());
          }
        });
        if (this.registeredArguments.length > 0 && this.registeredArguments[this.registeredArguments.length - 1].variadic) {
          return;
        }
        if (this.args.length > this.registeredArguments.length) {
          this._excessArguments(this.args);
        }
      }
      /**
       * Process this.args using this.registeredArguments and save as this.processedArgs!
       *
       * @private
       */
      _processArguments() {
        const myParseArg = (argument, value, previous) => {
          let parsedValue = value;
          if (value !== null && argument.parseArg) {
            const invalidValueMessage = `error: command-argument value '${value}' is invalid for argument '${argument.name()}'.`;
            parsedValue = this._callParseArg(
              argument,
              value,
              previous,
              invalidValueMessage
            );
          }
          return parsedValue;
        };
        this._checkNumberOfArguments();
        const processedArgs = [];
        this.registeredArguments.forEach((declaredArg, index) => {
          let value = declaredArg.defaultValue;
          if (declaredArg.variadic) {
            if (index < this.args.length) {
              value = this.args.slice(index);
              if (declaredArg.parseArg) {
                value = value.reduce((processed, v) => {
                  return myParseArg(declaredArg, v, processed);
                }, declaredArg.defaultValue);
              }
            } else if (value === void 0) {
              value = [];
            }
          } else if (index < this.args.length) {
            value = this.args[index];
            if (declaredArg.parseArg) {
              value = myParseArg(declaredArg, value, declaredArg.defaultValue);
            }
          }
          processedArgs[index] = value;
        });
        this.processedArgs = processedArgs;
      }
      /**
       * Once we have a promise we chain, but call synchronously until then.
       *
       * @param {(Promise|undefined)} promise
       * @param {Function} fn
       * @return {(Promise|undefined)}
       * @private
       */
      _chainOrCall(promise, fn) {
        if (promise && promise.then && typeof promise.then === "function") {
          return promise.then(() => fn());
        }
        return fn();
      }
      /**
       *
       * @param {(Promise|undefined)} promise
       * @param {string} event
       * @return {(Promise|undefined)}
       * @private
       */
      _chainOrCallHooks(promise, event) {
        let result = promise;
        const hooks = [];
        this._getCommandAndAncestors().reverse().filter((cmd) => cmd._lifeCycleHooks[event] !== void 0).forEach((hookedCommand) => {
          hookedCommand._lifeCycleHooks[event].forEach((callback) => {
            hooks.push({ hookedCommand, callback });
          });
        });
        if (event === "postAction") {
          hooks.reverse();
        }
        hooks.forEach((hookDetail) => {
          result = this._chainOrCall(result, () => {
            return hookDetail.callback(hookDetail.hookedCommand, this);
          });
        });
        return result;
      }
      /**
       *
       * @param {(Promise|undefined)} promise
       * @param {Command} subCommand
       * @param {string} event
       * @return {(Promise|undefined)}
       * @private
       */
      _chainOrCallSubCommandHook(promise, subCommand, event) {
        let result = promise;
        if (this._lifeCycleHooks[event] !== void 0) {
          this._lifeCycleHooks[event].forEach((hook) => {
            result = this._chainOrCall(result, () => {
              return hook(this, subCommand);
            });
          });
        }
        return result;
      }
      /**
       * Process arguments in context of this command.
       * Returns action result, in case it is a promise.
       *
       * @private
       */
      _parseCommand(operands, unknown) {
        const parsed = this.parseOptions(unknown);
        this._parseOptionsEnv();
        this._parseOptionsImplied();
        operands = operands.concat(parsed.operands);
        unknown = parsed.unknown;
        this.args = operands.concat(unknown);
        if (operands && this._findCommand(operands[0])) {
          return this._dispatchSubcommand(operands[0], operands.slice(1), unknown);
        }
        if (this._getHelpCommand() && operands[0] === this._getHelpCommand().name()) {
          return this._dispatchHelpCommand(operands[1]);
        }
        if (this._defaultCommandName) {
          this._outputHelpIfRequested(unknown);
          return this._dispatchSubcommand(
            this._defaultCommandName,
            operands,
            unknown
          );
        }
        if (this.commands.length && this.args.length === 0 && !this._actionHandler && !this._defaultCommandName) {
          this.help({ error: true });
        }
        this._outputHelpIfRequested(parsed.unknown);
        this._checkForMissingMandatoryOptions();
        this._checkForConflictingOptions();
        const checkForUnknownOptions = () => {
          if (parsed.unknown.length > 0) {
            this.unknownOption(parsed.unknown[0]);
          }
        };
        const commandEvent = `command:${this.name()}`;
        if (this._actionHandler) {
          checkForUnknownOptions();
          this._processArguments();
          let promiseChain;
          promiseChain = this._chainOrCallHooks(promiseChain, "preAction");
          promiseChain = this._chainOrCall(
            promiseChain,
            () => this._actionHandler(this.processedArgs)
          );
          if (this.parent) {
            promiseChain = this._chainOrCall(promiseChain, () => {
              this.parent.emit(commandEvent, operands, unknown);
            });
          }
          promiseChain = this._chainOrCallHooks(promiseChain, "postAction");
          return promiseChain;
        }
        if (this.parent && this.parent.listenerCount(commandEvent)) {
          checkForUnknownOptions();
          this._processArguments();
          this.parent.emit(commandEvent, operands, unknown);
        } else if (operands.length) {
          if (this._findCommand("*")) {
            return this._dispatchSubcommand("*", operands, unknown);
          }
          if (this.listenerCount("command:*")) {
            this.emit("command:*", operands, unknown);
          } else if (this.commands.length) {
            this.unknownCommand();
          } else {
            checkForUnknownOptions();
            this._processArguments();
          }
        } else if (this.commands.length) {
          checkForUnknownOptions();
          this.help({ error: true });
        } else {
          checkForUnknownOptions();
          this._processArguments();
        }
      }
      /**
       * Find matching command.
       *
       * @private
       * @return {Command | undefined}
       */
      _findCommand(name) {
        if (!name) return void 0;
        return this.commands.find(
          (cmd) => cmd._name === name || cmd._aliases.includes(name)
        );
      }
      /**
       * Return an option matching `arg` if any.
       *
       * @param {string} arg
       * @return {Option}
       * @package
       */
      _findOption(arg) {
        return this.options.find((option) => option.is(arg));
      }
      /**
       * Display an error message if a mandatory option does not have a value.
       * Called after checking for help flags in leaf subcommand.
       *
       * @private
       */
      _checkForMissingMandatoryOptions() {
        this._getCommandAndAncestors().forEach((cmd) => {
          cmd.options.forEach((anOption) => {
            if (anOption.mandatory && cmd.getOptionValue(anOption.attributeName()) === void 0) {
              cmd.missingMandatoryOptionValue(anOption);
            }
          });
        });
      }
      /**
       * Display an error message if conflicting options are used together in this.
       *
       * @private
       */
      _checkForConflictingLocalOptions() {
        const definedNonDefaultOptions = this.options.filter((option) => {
          const optionKey = option.attributeName();
          if (this.getOptionValue(optionKey) === void 0) {
            return false;
          }
          return this.getOptionValueSource(optionKey) !== "default";
        });
        const optionsWithConflicting = definedNonDefaultOptions.filter(
          (option) => option.conflictsWith.length > 0
        );
        optionsWithConflicting.forEach((option) => {
          const conflictingAndDefined = definedNonDefaultOptions.find(
            (defined) => option.conflictsWith.includes(defined.attributeName())
          );
          if (conflictingAndDefined) {
            this._conflictingOption(option, conflictingAndDefined);
          }
        });
      }
      /**
       * Display an error message if conflicting options are used together.
       * Called after checking for help flags in leaf subcommand.
       *
       * @private
       */
      _checkForConflictingOptions() {
        this._getCommandAndAncestors().forEach((cmd) => {
          cmd._checkForConflictingLocalOptions();
        });
      }
      /**
       * Parse options from `argv` removing known options,
       * and return argv split into operands and unknown arguments.
       *
       * Examples:
       *
       *     argv => operands, unknown
       *     --known kkk op => [op], []
       *     op --known kkk => [op], []
       *     sub --unknown uuu op => [sub], [--unknown uuu op]
       *     sub -- --unknown uuu op => [sub --unknown uuu op], []
       *
       * @param {string[]} argv
       * @return {{operands: string[], unknown: string[]}}
       */
      parseOptions(argv) {
        const operands = [];
        const unknown = [];
        let dest = operands;
        const args = argv.slice();
        function maybeOption(arg) {
          return arg.length > 1 && arg[0] === "-";
        }
        let activeVariadicOption = null;
        while (args.length) {
          const arg = args.shift();
          if (arg === "--") {
            if (dest === unknown) dest.push(arg);
            dest.push(...args);
            break;
          }
          if (activeVariadicOption && !maybeOption(arg)) {
            this.emit(`option:${activeVariadicOption.name()}`, arg);
            continue;
          }
          activeVariadicOption = null;
          if (maybeOption(arg)) {
            const option = this._findOption(arg);
            if (option) {
              if (option.required) {
                const value = args.shift();
                if (value === void 0) this.optionMissingArgument(option);
                this.emit(`option:${option.name()}`, value);
              } else if (option.optional) {
                let value = null;
                if (args.length > 0 && !maybeOption(args[0])) {
                  value = args.shift();
                }
                this.emit(`option:${option.name()}`, value);
              } else {
                this.emit(`option:${option.name()}`);
              }
              activeVariadicOption = option.variadic ? option : null;
              continue;
            }
          }
          if (arg.length > 2 && arg[0] === "-" && arg[1] !== "-") {
            const option = this._findOption(`-${arg[1]}`);
            if (option) {
              if (option.required || option.optional && this._combineFlagAndOptionalValue) {
                this.emit(`option:${option.name()}`, arg.slice(2));
              } else {
                this.emit(`option:${option.name()}`);
                args.unshift(`-${arg.slice(2)}`);
              }
              continue;
            }
          }
          if (/^--[^=]+=/.test(arg)) {
            const index = arg.indexOf("=");
            const option = this._findOption(arg.slice(0, index));
            if (option && (option.required || option.optional)) {
              this.emit(`option:${option.name()}`, arg.slice(index + 1));
              continue;
            }
          }
          if (maybeOption(arg)) {
            dest = unknown;
          }
          if ((this._enablePositionalOptions || this._passThroughOptions) && operands.length === 0 && unknown.length === 0) {
            if (this._findCommand(arg)) {
              operands.push(arg);
              if (args.length > 0) unknown.push(...args);
              break;
            } else if (this._getHelpCommand() && arg === this._getHelpCommand().name()) {
              operands.push(arg);
              if (args.length > 0) operands.push(...args);
              break;
            } else if (this._defaultCommandName) {
              unknown.push(arg);
              if (args.length > 0) unknown.push(...args);
              break;
            }
          }
          if (this._passThroughOptions) {
            dest.push(arg);
            if (args.length > 0) dest.push(...args);
            break;
          }
          dest.push(arg);
        }
        return { operands, unknown };
      }
      /**
       * Return an object containing local option values as key-value pairs.
       *
       * @return {object}
       */
      opts() {
        if (this._storeOptionsAsProperties) {
          const result = {};
          const len = this.options.length;
          for (let i = 0; i < len; i++) {
            const key = this.options[i].attributeName();
            result[key] = key === this._versionOptionName ? this._version : this[key];
          }
          return result;
        }
        return this._optionValues;
      }
      /**
       * Return an object containing merged local and global option values as key-value pairs.
       *
       * @return {object}
       */
      optsWithGlobals() {
        return this._getCommandAndAncestors().reduce(
          (combinedOptions, cmd) => Object.assign(combinedOptions, cmd.opts()),
          {}
        );
      }
      /**
       * Display error message and exit (or call exitOverride).
       *
       * @param {string} message
       * @param {object} [errorOptions]
       * @param {string} [errorOptions.code] - an id string representing the error
       * @param {number} [errorOptions.exitCode] - used with process.exit
       */
      error(message, errorOptions) {
        this._outputConfiguration.outputError(
          `${message}
`,
          this._outputConfiguration.writeErr
        );
        if (typeof this._showHelpAfterError === "string") {
          this._outputConfiguration.writeErr(`${this._showHelpAfterError}
`);
        } else if (this._showHelpAfterError) {
          this._outputConfiguration.writeErr("\n");
          this.outputHelp({ error: true });
        }
        const config = errorOptions || {};
        const exitCode = config.exitCode || 1;
        const code = config.code || "commander.error";
        this._exit(exitCode, code, message);
      }
      /**
       * Apply any option related environment variables, if option does
       * not have a value from cli or client code.
       *
       * @private
       */
      _parseOptionsEnv() {
        this.options.forEach((option) => {
          if (option.envVar && option.envVar in process2.env) {
            const optionKey = option.attributeName();
            if (this.getOptionValue(optionKey) === void 0 || ["default", "config", "env"].includes(
              this.getOptionValueSource(optionKey)
            )) {
              if (option.required || option.optional) {
                this.emit(`optionEnv:${option.name()}`, process2.env[option.envVar]);
              } else {
                this.emit(`optionEnv:${option.name()}`);
              }
            }
          }
        });
      }
      /**
       * Apply any implied option values, if option is undefined or default value.
       *
       * @private
       */
      _parseOptionsImplied() {
        const dualHelper = new DualOptions(this.options);
        const hasCustomOptionValue = (optionKey) => {
          return this.getOptionValue(optionKey) !== void 0 && !["default", "implied"].includes(this.getOptionValueSource(optionKey));
        };
        this.options.filter(
          (option) => option.implied !== void 0 && hasCustomOptionValue(option.attributeName()) && dualHelper.valueFromOption(
            this.getOptionValue(option.attributeName()),
            option
          )
        ).forEach((option) => {
          Object.keys(option.implied).filter((impliedKey) => !hasCustomOptionValue(impliedKey)).forEach((impliedKey) => {
            this.setOptionValueWithSource(
              impliedKey,
              option.implied[impliedKey],
              "implied"
            );
          });
        });
      }
      /**
       * Argument `name` is missing.
       *
       * @param {string} name
       * @private
       */
      missingArgument(name) {
        const message = `error: missing required argument '${name}'`;
        this.error(message, { code: "commander.missingArgument" });
      }
      /**
       * `Option` is missing an argument.
       *
       * @param {Option} option
       * @private
       */
      optionMissingArgument(option) {
        const message = `error: option '${option.flags}' argument missing`;
        this.error(message, { code: "commander.optionMissingArgument" });
      }
      /**
       * `Option` does not have a value, and is a mandatory option.
       *
       * @param {Option} option
       * @private
       */
      missingMandatoryOptionValue(option) {
        const message = `error: required option '${option.flags}' not specified`;
        this.error(message, { code: "commander.missingMandatoryOptionValue" });
      }
      /**
       * `Option` conflicts with another option.
       *
       * @param {Option} option
       * @param {Option} conflictingOption
       * @private
       */
      _conflictingOption(option, conflictingOption) {
        const findBestOptionFromValue = (option2) => {
          const optionKey = option2.attributeName();
          const optionValue = this.getOptionValue(optionKey);
          const negativeOption = this.options.find(
            (target) => target.negate && optionKey === target.attributeName()
          );
          const positiveOption = this.options.find(
            (target) => !target.negate && optionKey === target.attributeName()
          );
          if (negativeOption && (negativeOption.presetArg === void 0 && optionValue === false || negativeOption.presetArg !== void 0 && optionValue === negativeOption.presetArg)) {
            return negativeOption;
          }
          return positiveOption || option2;
        };
        const getErrorMessage = (option2) => {
          const bestOption = findBestOptionFromValue(option2);
          const optionKey = bestOption.attributeName();
          const source = this.getOptionValueSource(optionKey);
          if (source === "env") {
            return `environment variable '${bestOption.envVar}'`;
          }
          return `option '${bestOption.flags}'`;
        };
        const message = `error: ${getErrorMessage(option)} cannot be used with ${getErrorMessage(conflictingOption)}`;
        this.error(message, { code: "commander.conflictingOption" });
      }
      /**
       * Unknown option `flag`.
       *
       * @param {string} flag
       * @private
       */
      unknownOption(flag) {
        if (this._allowUnknownOption) return;
        let suggestion = "";
        if (flag.startsWith("--") && this._showSuggestionAfterError) {
          let candidateFlags = [];
          let command = this;
          do {
            const moreFlags = command.createHelp().visibleOptions(command).filter((option) => option.long).map((option) => option.long);
            candidateFlags = candidateFlags.concat(moreFlags);
            command = command.parent;
          } while (command && !command._enablePositionalOptions);
          suggestion = suggestSimilar(flag, candidateFlags);
        }
        const message = `error: unknown option '${flag}'${suggestion}`;
        this.error(message, { code: "commander.unknownOption" });
      }
      /**
       * Excess arguments, more than expected.
       *
       * @param {string[]} receivedArgs
       * @private
       */
      _excessArguments(receivedArgs) {
        if (this._allowExcessArguments) return;
        const expected = this.registeredArguments.length;
        const s = expected === 1 ? "" : "s";
        const forSubcommand = this.parent ? ` for '${this.name()}'` : "";
        const message = `error: too many arguments${forSubcommand}. Expected ${expected} argument${s} but got ${receivedArgs.length}.`;
        this.error(message, { code: "commander.excessArguments" });
      }
      /**
       * Unknown command.
       *
       * @private
       */
      unknownCommand() {
        const unknownName = this.args[0];
        let suggestion = "";
        if (this._showSuggestionAfterError) {
          const candidateNames = [];
          this.createHelp().visibleCommands(this).forEach((command) => {
            candidateNames.push(command.name());
            if (command.alias()) candidateNames.push(command.alias());
          });
          suggestion = suggestSimilar(unknownName, candidateNames);
        }
        const message = `error: unknown command '${unknownName}'${suggestion}`;
        this.error(message, { code: "commander.unknownCommand" });
      }
      /**
       * Get or set the program version.
       *
       * This method auto-registers the "-V, --version" option which will print the version number.
       *
       * You can optionally supply the flags and description to override the defaults.
       *
       * @param {string} [str]
       * @param {string} [flags]
       * @param {string} [description]
       * @return {(this | string | undefined)} `this` command for chaining, or version string if no arguments
       */
      version(str, flags, description) {
        if (str === void 0) return this._version;
        this._version = str;
        flags = flags || "-V, --version";
        description = description || "output the version number";
        const versionOption = this.createOption(flags, description);
        this._versionOptionName = versionOption.attributeName();
        this._registerOption(versionOption);
        this.on("option:" + versionOption.name(), () => {
          this._outputConfiguration.writeOut(`${str}
`);
          this._exit(0, "commander.version", str);
        });
        return this;
      }
      /**
       * Set the description.
       *
       * @param {string} [str]
       * @param {object} [argsDescription]
       * @return {(string|Command)}
       */
      description(str, argsDescription) {
        if (str === void 0 && argsDescription === void 0)
          return this._description;
        this._description = str;
        if (argsDescription) {
          this._argsDescription = argsDescription;
        }
        return this;
      }
      /**
       * Set the summary. Used when listed as subcommand of parent.
       *
       * @param {string} [str]
       * @return {(string|Command)}
       */
      summary(str) {
        if (str === void 0) return this._summary;
        this._summary = str;
        return this;
      }
      /**
       * Set an alias for the command.
       *
       * You may call more than once to add multiple aliases. Only the first alias is shown in the auto-generated help.
       *
       * @param {string} [alias]
       * @return {(string|Command)}
       */
      alias(alias) {
        if (alias === void 0) return this._aliases[0];
        let command = this;
        if (this.commands.length !== 0 && this.commands[this.commands.length - 1]._executableHandler) {
          command = this.commands[this.commands.length - 1];
        }
        if (alias === command._name)
          throw new Error("Command alias can't be the same as its name");
        const matchingCommand = this.parent?._findCommand(alias);
        if (matchingCommand) {
          const existingCmd = [matchingCommand.name()].concat(matchingCommand.aliases()).join("|");
          throw new Error(
            `cannot add alias '${alias}' to command '${this.name()}' as already have command '${existingCmd}'`
          );
        }
        command._aliases.push(alias);
        return this;
      }
      /**
       * Set aliases for the command.
       *
       * Only the first alias is shown in the auto-generated help.
       *
       * @param {string[]} [aliases]
       * @return {(string[]|Command)}
       */
      aliases(aliases) {
        if (aliases === void 0) return this._aliases;
        aliases.forEach((alias) => this.alias(alias));
        return this;
      }
      /**
       * Set / get the command usage `str`.
       *
       * @param {string} [str]
       * @return {(string|Command)}
       */
      usage(str) {
        if (str === void 0) {
          if (this._usage) return this._usage;
          const args = this.registeredArguments.map((arg) => {
            return humanReadableArgName(arg);
          });
          return [].concat(
            this.options.length || this._helpOption !== null ? "[options]" : [],
            this.commands.length ? "[command]" : [],
            this.registeredArguments.length ? args : []
          ).join(" ");
        }
        this._usage = str;
        return this;
      }
      /**
       * Get or set the name of the command.
       *
       * @param {string} [str]
       * @return {(string|Command)}
       */
      name(str) {
        if (str === void 0) return this._name;
        this._name = str;
        return this;
      }
      /**
       * Set the name of the command from script filename, such as process.argv[1],
       * or require.main.filename, or __filename.
       *
       * (Used internally and public although not documented in README.)
       *
       * @example
       * program.nameFromFilename(require.main.filename);
       *
       * @param {string} filename
       * @return {Command}
       */
      nameFromFilename(filename) {
        this._name = path.basename(filename, path.extname(filename));
        return this;
      }
      /**
       * Get or set the directory for searching for executable subcommands of this command.
       *
       * @example
       * program.executableDir(__dirname);
       * // or
       * program.executableDir('subcommands');
       *
       * @param {string} [path]
       * @return {(string|null|Command)}
       */
      executableDir(path2) {
        if (path2 === void 0) return this._executableDir;
        this._executableDir = path2;
        return this;
      }
      /**
       * Return program help documentation.
       *
       * @param {{ error: boolean }} [contextOptions] - pass {error:true} to wrap for stderr instead of stdout
       * @return {string}
       */
      helpInformation(contextOptions) {
        const helper = this.createHelp();
        if (helper.helpWidth === void 0) {
          helper.helpWidth = contextOptions && contextOptions.error ? this._outputConfiguration.getErrHelpWidth() : this._outputConfiguration.getOutHelpWidth();
        }
        return helper.formatHelp(this, helper);
      }
      /**
       * @private
       */
      _getHelpContext(contextOptions) {
        contextOptions = contextOptions || {};
        const context = { error: !!contextOptions.error };
        let write;
        if (context.error) {
          write = (arg) => this._outputConfiguration.writeErr(arg);
        } else {
          write = (arg) => this._outputConfiguration.writeOut(arg);
        }
        context.write = contextOptions.write || write;
        context.command = this;
        return context;
      }
      /**
       * Output help information for this command.
       *
       * Outputs built-in help, and custom text added using `.addHelpText()`.
       *
       * @param {{ error: boolean } | Function} [contextOptions] - pass {error:true} to write to stderr instead of stdout
       */
      outputHelp(contextOptions) {
        let deprecatedCallback;
        if (typeof contextOptions === "function") {
          deprecatedCallback = contextOptions;
          contextOptions = void 0;
        }
        const context = this._getHelpContext(contextOptions);
        this._getCommandAndAncestors().reverse().forEach((command) => command.emit("beforeAllHelp", context));
        this.emit("beforeHelp", context);
        let helpInformation = this.helpInformation(context);
        if (deprecatedCallback) {
          helpInformation = deprecatedCallback(helpInformation);
          if (typeof helpInformation !== "string" && !Buffer.isBuffer(helpInformation)) {
            throw new Error("outputHelp callback must return a string or a Buffer");
          }
        }
        context.write(helpInformation);
        if (this._getHelpOption()?.long) {
          this.emit(this._getHelpOption().long);
        }
        this.emit("afterHelp", context);
        this._getCommandAndAncestors().forEach(
          (command) => command.emit("afterAllHelp", context)
        );
      }
      /**
       * You can pass in flags and a description to customise the built-in help option.
       * Pass in false to disable the built-in help option.
       *
       * @example
       * program.helpOption('-?, --help' 'show help'); // customise
       * program.helpOption(false); // disable
       *
       * @param {(string | boolean)} flags
       * @param {string} [description]
       * @return {Command} `this` command for chaining
       */
      helpOption(flags, description) {
        if (typeof flags === "boolean") {
          if (flags) {
            this._helpOption = this._helpOption ?? void 0;
          } else {
            this._helpOption = null;
          }
          return this;
        }
        flags = flags ?? "-h, --help";
        description = description ?? "display help for command";
        this._helpOption = this.createOption(flags, description);
        return this;
      }
      /**
       * Lazy create help option.
       * Returns null if has been disabled with .helpOption(false).
       *
       * @returns {(Option | null)} the help option
       * @package
       */
      _getHelpOption() {
        if (this._helpOption === void 0) {
          this.helpOption(void 0, void 0);
        }
        return this._helpOption;
      }
      /**
       * Supply your own option to use for the built-in help option.
       * This is an alternative to using helpOption() to customise the flags and description etc.
       *
       * @param {Option} option
       * @return {Command} `this` command for chaining
       */
      addHelpOption(option) {
        this._helpOption = option;
        return this;
      }
      /**
       * Output help information and exit.
       *
       * Outputs built-in help, and custom text added using `.addHelpText()`.
       *
       * @param {{ error: boolean }} [contextOptions] - pass {error:true} to write to stderr instead of stdout
       */
      help(contextOptions) {
        this.outputHelp(contextOptions);
        let exitCode = process2.exitCode || 0;
        if (exitCode === 0 && contextOptions && typeof contextOptions !== "function" && contextOptions.error) {
          exitCode = 1;
        }
        this._exit(exitCode, "commander.help", "(outputHelp)");
      }
      /**
       * Add additional text to be displayed with the built-in help.
       *
       * Position is 'before' or 'after' to affect just this command,
       * and 'beforeAll' or 'afterAll' to affect this command and all its subcommands.
       *
       * @param {string} position - before or after built-in help
       * @param {(string | Function)} text - string to add, or a function returning a string
       * @return {Command} `this` command for chaining
       */
      addHelpText(position, text) {
        const allowedValues = ["beforeAll", "before", "after", "afterAll"];
        if (!allowedValues.includes(position)) {
          throw new Error(`Unexpected value for position to addHelpText.
Expecting one of '${allowedValues.join("', '")}'`);
        }
        const helpEvent = `${position}Help`;
        this.on(helpEvent, (context) => {
          let helpStr;
          if (typeof text === "function") {
            helpStr = text({ error: context.error, command: context.command });
          } else {
            helpStr = text;
          }
          if (helpStr) {
            context.write(`${helpStr}
`);
          }
        });
        return this;
      }
      /**
       * Output help information if help flags specified
       *
       * @param {Array} args - array of options to search for help flags
       * @private
       */
      _outputHelpIfRequested(args) {
        const helpOption = this._getHelpOption();
        const helpRequested = helpOption && args.find((arg) => helpOption.is(arg));
        if (helpRequested) {
          this.outputHelp();
          this._exit(0, "commander.helpDisplayed", "(outputHelp)");
        }
      }
    };
    function incrementNodeInspectorPort(args) {
      return args.map((arg) => {
        if (!arg.startsWith("--inspect")) {
          return arg;
        }
        let debugOption;
        let debugHost = "127.0.0.1";
        let debugPort = "9229";
        let match;
        if ((match = arg.match(/^(--inspect(-brk)?)$/)) !== null) {
          debugOption = match[1];
        } else if ((match = arg.match(/^(--inspect(-brk|-port)?)=([^:]+)$/)) !== null) {
          debugOption = match[1];
          if (/^\d+$/.test(match[3])) {
            debugPort = match[3];
          } else {
            debugHost = match[3];
          }
        } else if ((match = arg.match(/^(--inspect(-brk|-port)?)=([^:]+):(\d+)$/)) !== null) {
          debugOption = match[1];
          debugHost = match[3];
          debugPort = match[4];
        }
        if (debugOption && debugPort !== "0") {
          return `${debugOption}=${debugHost}:${parseInt(debugPort) + 1}`;
        }
        return arg;
      });
    }
    exports2.Command = Command2;
  }
});

// node_modules/commander/index.js
var require_commander = __commonJS({
  "node_modules/commander/index.js"(exports2) {
    var { Argument: Argument2 } = require_argument();
    var { Command: Command2 } = require_command();
    var { CommanderError: CommanderError2, InvalidArgumentError: InvalidArgumentError2 } = require_error();
    var { Help: Help2 } = require_help();
    var { Option: Option2 } = require_option();
    exports2.program = new Command2();
    exports2.createCommand = (name) => new Command2(name);
    exports2.createOption = (flags, description) => new Option2(flags, description);
    exports2.createArgument = (name, description) => new Argument2(name, description);
    exports2.Command = Command2;
    exports2.Option = Option2;
    exports2.Argument = Argument2;
    exports2.Help = Help2;
    exports2.CommanderError = CommanderError2;
    exports2.InvalidArgumentError = InvalidArgumentError2;
    exports2.InvalidOptionArgumentError = InvalidArgumentError2;
  }
});

// node_modules/commander/esm.mjs
var import_index = __toESM(require_commander(), 1);
var {
  program,
  createCommand,
  createArgument,
  createOption,
  CommanderError,
  InvalidArgumentError,
  InvalidOptionArgumentError,
  // deprecated old name
  Command,
  Argument,
  Option,
  Help
} = import_index.default;

// packages/cli/src/index.ts
var import_node_fs3 = require("node:fs");
var import_node_child_process = require("node:child_process");
var import_node_crypto4 = require("node:crypto");
var import_node_os2 = require("node:os");
var import_node_path2 = require("node:path");

// packages/core/dist/cost.js
var PRICING_TABLE = [
  { match: /fable/i, pricing: { inputPerM: 25, outputPerM: 125 } },
  { match: /opus/i, pricing: { inputPerM: 15, outputPerM: 75 } },
  { match: /sonnet/i, pricing: { inputPerM: 3, outputPerM: 15 } },
  { match: /haiku/i, pricing: { inputPerM: 0.8, outputPerM: 4 } }
];
var FALLBACK = { inputPerM: 3, outputPerM: 15 };
function pricingFor(model) {
  for (const { match, pricing } of PRICING_TABLE) {
    if (match.test(model))
      return pricing;
  }
  return FALLBACK;
}
function usageCostUsd(model, usage) {
  const p = pricingFor(model);
  return (usage.inputTokens * p.inputPerM + usage.cacheCreationInputTokens * p.inputPerM * 1.25 + usage.cacheReadInputTokens * p.inputPerM * 0.1 + usage.outputTokens * p.outputPerM) / 1e6;
}
function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0
  };
}
function addUsage(a, b) {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens
  };
}
function cacheReadRatio(usages) {
  let read = 0;
  let allInput = 0;
  for (const u of usages) {
    read += u.cacheReadInputTokens;
    allInput += u.inputTokens + u.cacheCreationInputTokens + u.cacheReadInputTokens;
  }
  return allInput === 0 ? 0 : read / allInput;
}

// packages/core/dist/canonicalize.js
var RE_URL = /https?:\/\/([^\s/"'<>)\]]+)[^\s"'<>)\]]*/g;
var RE_UUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
var RE_EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
var RE_ISO_TS = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;
var RE_CLOCK = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g;
var RE_HEX_ID = /(?<![A-Za-z0-9])(?=[0-9a-fA-F]*\d)[0-9a-fA-F]{7,64}(?![A-Za-z0-9])/g;
var RE_PATH = /(?:~|\.{1,2})?(?:\/[\w.@+~-]+){2,}\/?/g;
var RE_GIT_REF = /\b(?:refs\/[\w/.-]+|origin\/[\w/.-]+)\b/g;
var RE_ISSUE_REF = /#\d+\b/g;
var RE_OPAQUE = /\b[A-Za-z0-9_-]{24,}\b/g;
var RE_NUM = /\b\d+(?:\.\d+)?\b/g;
function replacePaths(s) {
  return s.replace(RE_PATH, (m) => {
    const last = m.replace(/\/+$/, "").split("/").pop() ?? "";
    const dot = last.lastIndexOf(".");
    const ext = dot > 0 ? last.slice(dot) : "";
    return ext && /^\.[A-Za-z0-9]{1,8}$/.test(ext) ? `<PATH:${ext}>` : "<PATH>";
  });
}
var RE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
var RE_LONE_HI_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g;
var RE_LONE_LO_SURROGATE = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
function stripControlChars(input) {
  return input.replace(RE_CONTROL, "").replace(RE_LONE_HI_SURROGATE, "").replace(RE_LONE_LO_SURROGATE, "");
}
function canonicalizeText(input) {
  let s = stripControlChars(input);
  s = s.replace(RE_URL, (_m, host) => `<URL:${host.replace(/:\d+$/, "")}>`);
  s = s.replace(RE_UUID, "<ID>");
  s = s.replace(RE_EMAIL, "<EMAIL>");
  s = s.replace(RE_ISO_TS, "<TS>");
  s = replacePaths(s);
  s = s.replace(RE_GIT_REF, "<REF>");
  s = s.replace(RE_ISSUE_REF, "<REF>");
  s = s.replace(RE_CLOCK, "<TS>");
  s = s.replace(RE_HEX_ID, "<ID>");
  s = s.replace(RE_OPAQUE, (m) => /\d/.test(m) ? "<ID>" : m);
  s = s.replace(RE_NUM, "<NUM>");
  return s;
}
function templateOf(input, maxLen = 240) {
  const t = canonicalizeText(input.toLowerCase()).replace(/\s+/g, " ").trim();
  return t.length > maxLen ? `${t.slice(0, maxLen)}\u2026` : t;
}
function canonicalizeJsonValue(value, depth = 0) {
  if (value === null || value === void 0)
    return "null";
  if (typeof value === "string")
    return JSON.stringify(templateOf(value, 160));
  if (typeof value === "number")
    return "<NUM>";
  if (typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) {
    if (depth > 3)
      return "[\u2026]";
    return `[${value.map((v) => canonicalizeJsonValue(v, depth + 1)).join(",")}]`;
  }
  if (typeof value === "object") {
    if (depth > 3)
      return "{\u2026}";
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${k}:${canonicalizeJsonValue(v, depth + 1)}`).join(",")}}`;
  }
  return String(value);
}
function toolInputShape(input, maxLen = 160) {
  if (input === null || input === void 0 || typeof input !== "object") {
    return templateOf(String(input ?? ""), maxLen);
  }
  const obj = input;
  const keys = Object.keys(obj).sort();
  const parts = [];
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string") {
      parts.push(`${k}=${templateOf(v, 80)}`);
    } else if (typeof v === "number") {
      parts.push(`${k}=<NUM>`);
    } else if (typeof v === "boolean") {
      parts.push(`${k}=${v}`);
    } else {
      parts.push(`${k}=${canonicalizeJsonValue(v, 1)}`);
    }
  }
  const s = parts.join(" ");
  return s.length > maxLen ? `${s.slice(0, maxLen)}\u2026` : s;
}
function toolLabel(toolName, input) {
  return `tool:${toolName} ${toolInputShape(input)}`.trim();
}
function outputShape(text) {
  const len = text.length;
  const bucket = len === 0 ? "empty" : len < 200 ? "S" : len < 2e3 ? "M" : len < 2e4 ? "L" : "XL";
  return `${bucket}:${templateOf(text, 80)}`;
}
function modelTurnLabel(role, text) {
  return `${role}:${templateOf(text, 160)}`;
}

// packages/core/dist/transcript.js
var import_node_crypto = require("node:crypto");
function isMetaText(text) {
  const t = text.trimStart();
  return t.startsWith("<command-name>") || t.startsWith("<command-message>") || t.startsWith("<local-command-stdout>") || t.startsWith("<system-reminder>") || t.startsWith("<task-notification>") || t.startsWith("Caveat:");
}
function textOfContent(content) {
  if (typeof content === "string")
    return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b && typeof b === "object" && b.type === "text").map((b) => b.text ?? "").join("\n");
  }
  return "";
}
function toUsage(u) {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheCreationInputTokens: u?.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: u?.cache_read_input_tokens ?? 0
  };
}
function parseTranscript(jsonl, options = {}) {
  const steps = [];
  const toolNameById = /* @__PURE__ */ new Map();
  const usageByModel = {};
  const seenUsageKeys = /* @__PURE__ */ new Set();
  const models = /* @__PURE__ */ new Set();
  let sessionId;
  let cwd;
  let gitBranch;
  let startedAt;
  let endedAt;
  let firstPrompt;
  let finalOutput;
  let legacyCostUsd = 0;
  let hasUsage = false;
  for (const rawLine of jsonl.split("\n")) {
    const line = rawLine.trim();
    if (!line)
      continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    sessionId ??= obj.sessionId;
    if (obj.type !== "user" && obj.type !== "assistant")
      continue;
    if (obj.isMeta || obj.isSidechain)
      continue;
    cwd ??= obj.cwd;
    gitBranch ??= obj.gitBranch;
    if (obj.timestamp) {
      startedAt ??= obj.timestamp;
      endedAt = obj.timestamp;
    }
    const msg = obj.message;
    if (!msg)
      continue;
    if (obj.type === "user") {
      const content = msg.content;
      if (typeof content === "string") {
        if (content.trim() && !isMetaText(content)) {
          firstPrompt ??= content;
          steps.push({ kind: "model_turn", name: "user", payload: content, timestamp: obj.timestamp });
        }
      } else if (Array.isArray(content)) {
        for (const block of content) {
          const b = block;
          if (b.type === "text" && b.text?.trim() && !isMetaText(b.text)) {
            firstPrompt ??= b.text;
            steps.push({ kind: "model_turn", name: "user", payload: b.text, timestamp: obj.timestamp });
          } else if (b.type === "tool_result") {
            const toolName = b.tool_use_id && toolNameById.get(b.tool_use_id) || "unknown";
            steps.push({
              kind: "tool_result",
              name: toolName,
              payload: textOfContent(b.content).slice(0, 2e4),
              isError: b.is_error === true,
              toolUseId: b.tool_use_id,
              timestamp: obj.timestamp
            });
          }
        }
      }
    } else {
      if (typeof obj.costUSD === "number")
        legacyCostUsd += obj.costUSD;
      if (msg.model)
        models.add(msg.model);
      if (msg.usage && msg.model) {
        const key = obj.requestId ?? obj.uuid ?? `${obj.timestamp}`;
        if (!seenUsageKeys.has(key)) {
          seenUsageKeys.add(key);
          hasUsage = true;
          usageByModel[msg.model] = addUsage(usageByModel[msg.model] ?? emptyUsage(), toUsage(msg.usage));
        }
      }
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block;
          if (b.type === "text" && b.text?.trim()) {
            finalOutput = b.text;
            steps.push({ kind: "model_turn", name: "assistant", payload: b.text, timestamp: obj.timestamp });
          } else if (b.type === "thinking") {
            steps.push({ kind: "thinking", name: "assistant", payload: "", timestamp: obj.timestamp });
          } else if (b.type === "tool_use" && b.name) {
            if (b.id)
              toolNameById.set(b.id, b.name);
            steps.push({
              kind: "tool_use",
              name: b.name,
              payload: JSON.stringify(b.input ?? {}),
              toolUseId: b.id,
              timestamp: obj.timestamp
            });
          }
        }
      }
    }
  }
  const hasAssistant = steps.some((s) => s.kind !== "model_turn" || s.name === "assistant");
  if (!hasAssistant)
    return null;
  let costUsd = 0;
  if (hasUsage) {
    for (const [model, usage] of Object.entries(usageByModel)) {
      costUsd += usageCostUsd(model, usage);
    }
  } else {
    costUsd = legacyCostUsd;
  }
  const runId = sessionId ?? (0, import_node_crypto.createHash)("sha256").update(jsonl.slice(0, 4096)).digest("hex").slice(0, 16);
  const agentId = options.agentId ?? (cwd ? cwd.split("/").filter(Boolean).slice(-1)[0] : void 0) ?? options.defaultAgentId ?? "unknown-agent";
  return {
    runId,
    agentId,
    cwd,
    gitBranch,
    startedAt,
    endedAt,
    models: [...models],
    usageByModel,
    costUsd,
    steps,
    firstPrompt,
    finalOutput
  };
}

// packages/core/dist/graph.js
var import_node_crypto2 = require("node:crypto");
function sha256(s) {
  return (0, import_node_crypto2.createHash)("sha256").update(s).digest("hex");
}
function significantTokens(text, max = 40) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const tok of text.split(/[\s"'`,;()[\]{}<>]+/)) {
    if (tok.length < 12 || tok.length > 200)
      continue;
    if (/^[<>-]+$/.test(tok))
      continue;
    if (seen.has(tok))
      continue;
    seen.add(tok);
    out.push(tok);
    if (out.length >= max)
      break;
  }
  return out;
}
function buildRunGraph(run) {
  const nodes = [];
  for (const step of run.steps) {
    let label;
    let canonicalValue;
    switch (step.kind) {
      case "tool_use": {
        let input = step.payload;
        try {
          input = JSON.parse(step.payload);
        } catch {
        }
        label = toolLabel(step.name, input);
        canonicalValue = canonicalizeText(step.payload).slice(0, 4e3);
        break;
      }
      case "tool_result": {
        label = `result:${step.name} ${step.isError ? "error" : "ok"} ${outputShape(step.payload).split(":")[0]}`;
        canonicalValue = canonicalizeText(step.payload).slice(0, 4e3);
        break;
      }
      case "thinking": {
        label = "thinking";
        canonicalValue = "";
        break;
      }
      default: {
        label = modelTurnLabel(step.name, step.payload);
        canonicalValue = canonicalizeText(step.payload).slice(0, 4e3);
      }
    }
    nodes.push({
      index: nodes.length,
      kind: step.kind,
      label,
      canonicalValue,
      isError: step.isError === true,
      raw: step.payload.slice(0, 4e3)
    });
  }
  const edges = [];
  for (let i = 1; i < nodes.length; i++) {
    edges.push({ from: i - 1, to: i, type: "temporal" });
  }
  const WINDOW = 12;
  for (let i = 0; i < nodes.length; i++) {
    const src = nodes[i];
    if (src.kind !== "tool_result" && src.kind !== "model_turn")
      continue;
    const tokens = significantTokens(src.raw);
    if (tokens.length === 0)
      continue;
    for (let j = i + 1; j < Math.min(nodes.length, i + 1 + WINDOW); j++) {
      const dst = nodes[j];
      if (dst.kind !== "tool_use" && dst.kind !== "model_turn")
        continue;
      if (tokens.some((t) => dst.raw.includes(t))) {
        edges.push({ from: i, to: j, type: "dataflow" });
      }
    }
  }
  const labelSequence = nodes.map((n) => n.label);
  const l1 = sha256(labelSequence.join("\u241E"));
  const l0 = sha256(nodes.map((n) => `${n.label}\u241F${n.canonicalValue}`).join("\u241E"));
  return {
    runId: run.runId,
    agentId: run.agentId,
    nodes,
    edges,
    l0,
    l1,
    labelSequence,
    costUsd: run.costUsd,
    startedAt: run.startedAt,
    models: run.models,
    usageByModel: run.usageByModel,
    canonicalFinalOutput: run.finalOutput ? canonicalizeText(run.finalOutput).slice(0, 4e3) : void 0,
    finalOutputTemplate: run.finalOutput ? templateOf(run.finalOutput) : void 0,
    canonicalFirstPrompt: run.firstPrompt ? canonicalizeText(run.firstPrompt).slice(0, 2e3) : void 0,
    firstPrompt: run.firstPrompt?.slice(0, 500)
  };
}

// packages/core/dist/l2.js
function ngrams(s, n = 3) {
  const grams = [];
  for (let i = 0; i <= s.length - n; i++)
    grams.push(s.slice(i, i + n));
  return grams;
}
function vectorize(labelSequence) {
  const v = /* @__PURE__ */ new Map();
  for (const label of labelSequence) {
    v.set(`L:${label}`, (v.get(`L:${label}`) ?? 0) + 3);
    for (const g of ngrams(label)) {
      v.set(g, (v.get(g) ?? 0) + 1);
    }
  }
  return v;
}
function cosine(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [k, va] of small) {
    const vb = large.get(k);
    if (vb)
      dot += va * vb;
  }
  let na = 0;
  for (const v of a.values())
    na += v * v;
  let nb = 0;
  for (const v of b.values())
    nb += v * v;
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}
function clusterFamilies(shapes, options = {}) {
  const threshold = options.threshold ?? 0.82;
  const families = [];
  const assignment = /* @__PURE__ */ new Map();
  const sorted = [...shapes].sort((a, b) => b.labelSequence.length - a.labelSequence.length || a.l1.localeCompare(b.l1));
  for (const shape of sorted) {
    const vec = vectorize(shape.labelSequence);
    let best = null;
    for (let i = 0; i < families.length; i++) {
      const sim = cosine(vec, families[i].centroid);
      if (sim >= threshold && (!best || sim > best.sim))
        best = { idx: i, sim };
    }
    if (best) {
      const fam = families[best.idx];
      for (const [k, v] of vec) {
        fam.centroid.set(k, ((fam.centroid.get(k) ?? 0) * fam.members + v) / (fam.members + 1));
      }
      fam.members += 1;
      assignment.set(shape.l1, fam.id);
    } else {
      const id = `fam_${shape.l1.slice(0, 12)}`;
      families.push({ id, centroid: vec, members: 1 });
      assignment.set(shape.l1, id);
    }
  }
  return assignment;
}

// packages/core/dist/cluster.js
function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0)
    return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil(p / 100 * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}
function outputConsistency(runs) {
  const byInput = /* @__PURE__ */ new Map();
  for (const r of runs) {
    const key = r.canonicalFirstPrompt ?? "";
    (byInput.get(key) ?? byInput.set(key, []).get(key)).push(r);
  }
  let checked = 0;
  let consistent = 0;
  for (const group of byInput.values()) {
    if (group.length < 2)
      continue;
    const outputs = new Set(group.map((r) => r.canonicalFinalOutput ?? ""));
    checked += group.length;
    if (outputs.size === 1)
      consistent += group.length;
    else
      consistent += Math.max(...countBy(group.map((r) => r.canonicalFinalOutput ?? "")));
  }
  if (checked > 0)
    return consistent / checked;
  const templates = runs.map((r) => r.finalOutputTemplate ?? "");
  const modal = Math.max(...countBy(templates));
  return runs.length === 0 ? 0 : modal / runs.length;
}
function countBy(values) {
  const m = /* @__PURE__ */ new Map();
  for (const v of values)
    m.set(v, (m.get(v) ?? 0) + 1);
  return m.size === 0 ? [0] : [...m.values()];
}
function retrySubchains(run) {
  let count = 0;
  const nodes = run.nodes;
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].kind !== "tool_use")
      continue;
    for (let j = i + 1; j < Math.min(nodes.length, i + 4); j++) {
      if (nodes[j].kind === "tool_use" && nodes[j].label === nodes[i].label) {
        const between = nodes.slice(i + 1, j);
        if (between.some((n) => n.isError) || between.length === 0)
          count += 1;
        break;
      }
    }
  }
  return count;
}
function volatileSlots(runs) {
  if (runs.length < 2)
    return [];
  const len = runs[0].nodes.length;
  const slots = [];
  for (let i = 0; i < len; i++) {
    if (runs[0].nodes[i].kind !== "tool_use" && runs[0].nodes[i].kind !== "model_turn")
      continue;
    const values = /* @__PURE__ */ new Set();
    const examples = [];
    for (const r of runs) {
      const raw = r.nodes[i]?.raw ?? "";
      if (!values.has(raw)) {
        values.add(raw);
        if (examples.length < 3)
          examples.push(raw.slice(0, 120));
      }
    }
    if (values.size > 1) {
      slots.push({
        nodeIndex: i,
        label: runs[0].nodes[i].label.slice(0, 120),
        distinctValues: values.size,
        examples
      });
    }
  }
  return slots;
}
function computeMetrics(runs, modalPathFraction) {
  const costs = runs.map((r) => r.costUsd).sort((a, b) => a - b);
  const dates = runs.map((r) => r.startedAt).filter((d) => !!d).sort();
  const byL0 = /* @__PURE__ */ new Map();
  for (const r of runs) {
    (byL0.get(r.l0) ?? byL0.set(r.l0, []).get(r.l0)).push(r);
  }
  let dupRuns = 0;
  let dupCost = 0;
  for (const group of byL0.values()) {
    if (group.length > 1) {
      dupRuns += group.length - 1;
      dupCost += group.slice().sort((a, b) => a.costUsd - b.costUsd).slice(0, -1).reduce((s, r) => s + r.costUsd, 0);
    }
  }
  const modelMix = {};
  for (const r of runs) {
    for (const m of r.models)
      modelMix[m] = (modelMix[m] ?? 0) + 1;
  }
  const failures = runs.filter((r) => r.nodes.some((n) => n.isError)).length;
  const retries = runs.reduce((s, r) => s + retrySubchains(r), 0);
  return {
    nRuns: runs.length,
    totalCostUsd: costs.reduce((s, c) => s + c, 0),
    costP50Usd: percentile(costs, 50),
    costP95Usd: percentile(costs, 95),
    firstSeen: dates[0],
    lastSeen: dates[dates.length - 1],
    determinismScore: Math.max(0, Math.min(1, modalPathFraction * outputConsistency(runs))),
    failureRate: runs.length === 0 ? 0 : failures / runs.length,
    retrySubchains: retries,
    modelMix,
    volatileSlots: volatileSlots(runs),
    l0DuplicateRuns: dupRuns,
    l0DuplicateCostUsd: dupCost,
    cacheReadRatio: cacheReadRatio(runs.flatMap((r) => Object.values(r.usageByModel)))
  };
}
function clusterRuns(graphs) {
  const byAgent = /* @__PURE__ */ new Map();
  for (const g of graphs) {
    (byAgent.get(g.agentId) ?? byAgent.set(g.agentId, []).get(g.agentId)).push(g);
  }
  const clusters = [];
  for (const [agentId, runs] of byAgent) {
    const byL1 = /* @__PURE__ */ new Map();
    for (const r of runs) {
      (byL1.get(r.l1) ?? byL1.set(r.l1, []).get(r.l1)).push(r);
    }
    const shapes = [...byL1.entries()].map(([l1, rs]) => ({
      l1,
      labelSequence: rs[0].labelSequence
    }));
    const familyOf = clusterFamilies(shapes);
    const familyRunCounts = /* @__PURE__ */ new Map();
    const familyModalRuns = /* @__PURE__ */ new Map();
    for (const [l1, rs] of byL1) {
      const fam = familyOf.get(l1);
      familyRunCounts.set(fam, (familyRunCounts.get(fam) ?? 0) + rs.length);
      familyModalRuns.set(fam, Math.max(familyModalRuns.get(fam) ?? 0, rs.length));
    }
    for (const [l1, rs] of byL1) {
      const fam = familyOf.get(l1);
      const modalPathFraction = (familyModalRuns.get(fam) ?? rs.length) / (familyRunCounts.get(fam) ?? rs.length);
      clusters.push({
        clusterId: `cl_${agentId.replace(/[^\w-]/g, "_")}_${l1.slice(0, 12)}`,
        agentId,
        l1,
        familyId: fam,
        labelSequence: rs[0].labelSequence,
        runIds: rs.map((r) => r.runId),
        runs: rs,
        metrics: computeMetrics(rs, modalPathFraction)
      });
    }
  }
  return clusters.sort((a, b) => b.metrics.totalCostUsd - a.metrics.totalCostUsd);
}

// packages/core/dist/findings.js
var MAX_FINDINGS = 5;
function monthly(costUsd, windowDays) {
  return costUsd * (30 / Math.max(1, windowDays));
}
function round(n) {
  return Math.round(n * 100) / 100;
}
function shortShape(seq, max = 8) {
  if (seq.length <= max)
    return seq;
  return [...seq.slice(0, max - 1), `\u2026 +${seq.length - (max - 1)} more steps`];
}
function compileFindings(clusters, windowDays) {
  return clusters.filter((c) => c.metrics.determinismScore >= 0.9 && c.metrics.nRuns >= 10).map((c) => {
    const saving = monthly(c.metrics.totalCostUsd, windowDays) * 0.8;
    return {
      kind: "compile",
      title: `Compile it: "${describeCluster(c)}" ran ${c.metrics.nRuns}\xD7 as the same procedure`,
      agentId: c.agentId,
      clusterIds: [c.clusterId],
      estMonthlySavingUsd: round(saving),
      confidence: round(c.metrics.determinismScore),
      effort: 3,
      score: 0,
      recommendation: `This shape is ${(c.metrics.determinismScore * 100).toFixed(0)}% deterministic over ${c.metrics.nRuns} runs. Generate a script/skill with ${c.metrics.volatileSlots.length} parameter slot(s) (${c.metrics.volatileSlots.slice(0, 3).map((s) => s.label.split(" ")[0]).join(", ")}) and replace the agent loop for this procedure. Estimated saving = 80% of the cluster's cost.`,
      evidenceRunIds: c.runIds.slice(0, 10),
      labelSequence: shortShape(c.labelSequence),
      details: {
        determinism: c.metrics.determinismScore,
        nRuns: c.metrics.nRuns,
        volatileSlots: c.metrics.volatileSlots.slice(0, 8),
        clusterMonthlyCostUsd: round(monthly(c.metrics.totalCostUsd, windowDays))
      }
    };
  });
}
function cacheFindings(clusters, windowDays) {
  return clusters.filter((c) => c.metrics.l0DuplicateRuns >= 5).map((c) => ({
    kind: "cache",
    title: `Cache it: ${c.metrics.l0DuplicateRuns} literally identical re-runs of "${describeCluster(c)}"`,
    agentId: c.agentId,
    clusterIds: [c.clusterId],
    estMonthlySavingUsd: round(monthly(c.metrics.l0DuplicateCostUsd, windowDays)),
    confidence: 0.95,
    effort: 1,
    score: 0,
    recommendation: `${c.metrics.l0DuplicateRuns} runs had identical canonical inputs AND identical canonical graphs (equal L0). Cache the result keyed on the canonical input and skip re-execution.`,
    evidenceRunIds: c.runIds.slice(0, 10),
    labelSequence: shortShape(c.labelSequence),
    details: { duplicateRuns: c.metrics.l0DuplicateRuns, duplicateCostUsd: round(c.metrics.l0DuplicateCostUsd) }
  }));
}
function primaryModel(r) {
  return r.models[0];
}
function rightsizeFindings(clusters, windowDays) {
  const findings = [];
  for (const c of clusters) {
    const models = Object.keys(c.metrics.modelMix);
    if (models.length < 2)
      continue;
    const byModel = /* @__PURE__ */ new Map();
    for (const r of c.runs) {
      const m = primaryModel(r);
      if (!m)
        continue;
      (byModel.get(m) ?? byModel.set(m, []).get(m)).push(r);
    }
    if (byModel.size < 2)
      continue;
    const ranked = [...byModel.entries()].sort((a, b) => pricingFor(b[0]).outputPerM - pricingFor(a[0]).outputPerM);
    const [bigModel, bigRuns] = ranked[0];
    const [cheapModel, cheapRuns] = ranked[ranked.length - 1];
    if (bigModel === cheapModel || cheapRuns.length < 2 || bigRuns.length < 2)
      continue;
    const bigTemplates = bigRuns.map((r) => r.finalOutputTemplate ?? "");
    const modalBig = mode(bigTemplates);
    const matchRate = cheapRuns.filter((r) => (r.finalOutputTemplate ?? "") === modalBig).length / cheapRuns.length;
    if (matchRate < 0.6)
      continue;
    const avgBig = bigRuns.reduce((s, r) => s + r.costUsd, 0) / bigRuns.length;
    const avgCheap = cheapRuns.reduce((s, r) => s + r.costUsd, 0) / cheapRuns.length;
    if (avgBig <= avgCheap)
      continue;
    const saving = monthly((avgBig - avgCheap) * bigRuns.length, windowDays);
    findings.push({
      kind: "rightsize",
      title: `Right-size it: "${describeCluster(c)}" already succeeds on ${shortModel(cheapModel)}`,
      agentId: c.agentId,
      clusterIds: [c.clusterId],
      estMonthlySavingUsd: round(saving),
      confidence: round(0.5 + 0.4 * matchRate),
      effort: 1,
      score: 0,
      recommendation: `You already ran this shape on both ${shortModel(bigModel)} (${bigRuns.length} runs, $${avgBig.toFixed(2)}/run) and ${shortModel(cheapModel)} (${cheapRuns.length} runs, $${avgCheap.toFixed(2)}/run) \u2014 a natural experiment. The cheap model's outputs are template-consistent with the big model's in ${(matchRate * 100).toFixed(0)}% of runs. Pin this procedure to ${shortModel(cheapModel)}.`,
      evidenceRunIds: [...bigRuns.slice(0, 5), ...cheapRuns.slice(0, 5)].map((r) => r.runId),
      labelSequence: shortShape(c.labelSequence),
      details: { bigModel, cheapModel, avgBigUsd: round(avgBig), avgCheapUsd: round(avgCheap), matchRate: round(matchRate) }
    });
  }
  return findings;
}
function fixFindings(clusters, windowDays) {
  return clusters.filter((c) => c.metrics.retrySubchains >= 3 || c.metrics.failureRate >= 0.3 && c.metrics.nRuns >= 5).map((c) => {
    const retryShare = Math.min(0.6, c.metrics.retrySubchains / Math.max(1, c.metrics.nRuns) * 0.25 + c.metrics.failureRate * 0.3);
    return {
      kind: "fix",
      title: `Fix it: failure/retry motifs inside "${describeCluster(c)}"`,
      agentId: c.agentId,
      clusterIds: [c.clusterId],
      estMonthlySavingUsd: round(monthly(c.metrics.totalCostUsd, windowDays) * retryShare),
      confidence: 0.6,
      effort: 2,
      score: 0,
      recommendation: `${c.metrics.retrySubchains} retry sub-chains and a ${(c.metrics.failureRate * 100).toFixed(0)}% failure rate inside this shape. Root-cause the failing step and add a guard; non-final attempts are pure re-payment.`,
      evidenceRunIds: c.runIds.slice(0, 10),
      labelSequence: shortShape(c.labelSequence),
      details: { retrySubchains: c.metrics.retrySubchains, failureRate: round(c.metrics.failureRate) }
    };
  });
}
function precomputeFindings(clusters, windowDays) {
  const findings = [];
  const byAgent = /* @__PURE__ */ new Map();
  for (const c of clusters) {
    (byAgent.get(c.agentId) ?? byAgent.set(c.agentId, []).get(c.agentId)).push(c);
  }
  for (const [agentId, agentClusters] of byAgent) {
    const eligible = agentClusters.filter((c) => c.metrics.nRuns >= 2);
    if (eligible.length < 2)
      continue;
    for (let i = 0; i < eligible.length; i++) {
      for (let j = i + 1; j < eligible.length; j++) {
        const a = eligible[i].labelSequence;
        const b = eligible[j].labelSequence;
        let k = 0;
        while (k < a.length && k < b.length && a[k] === b[k])
          k++;
        if (k < 4)
          continue;
        const prefixFrac = (k / a.length + k / b.length) / 2;
        const combined = eligible[i].metrics.totalCostUsd + eligible[j].metrics.totalCostUsd;
        findings.push({
          kind: "precompute",
          title: `Precompute it: ${k}-step shared exploration prelude across 2 procedures`,
          agentId,
          clusterIds: [eligible[i].clusterId, eligible[j].clusterId],
          estMonthlySavingUsd: round(monthly(combined, windowDays) * prefixFrac * 0.6),
          confidence: 0.5,
          effort: 2,
          score: 0,
          recommendation: `Two distinct procedures start with the same ${k} steps (shared context discovery). Precompute that context once (e.g. a CLAUDE.md addition or a cached context artifact) and kill the exploration tax on every run.`,
          evidenceRunIds: [...eligible[i].runIds.slice(0, 5), ...eligible[j].runIds.slice(0, 5)],
          labelSequence: shortShape(a.slice(0, k)),
          details: { sharedPrefixSteps: k, prefixFraction: round(prefixFrac) }
        });
        break;
      }
    }
  }
  return findings;
}
function alignFindings(clusters, windowDays) {
  if (clusters.length === 0)
    return [];
  const byAgent = /* @__PURE__ */ new Map();
  for (const c of clusters) {
    (byAgent.get(c.agentId) ?? byAgent.set(c.agentId, []).get(c.agentId)).push(c);
  }
  const findings = [];
  for (const [agentId, agentClusters] of byAgent) {
    const totalRuns = agentClusters.reduce((s, c) => s + c.metrics.nRuns, 0);
    if (totalRuns < 10)
      continue;
    const totalCost = agentClusters.reduce((s, c) => s + c.metrics.totalCostUsd, 0);
    const weighted = agentClusters.reduce((s, c) => s + c.metrics.cacheReadRatio * c.metrics.totalCostUsd, 0) / Math.max(1e-9, totalCost);
    if (weighted >= 0.5)
      continue;
    findings.push({
      kind: "align",
      title: `Align it: prompt-cache read ratio is only ${(weighted * 100).toFixed(0)}% for ${agentId}`,
      agentId,
      clusterIds: agentClusters.slice(0, 5).map((c) => c.clusterId),
      estMonthlySavingUsd: round(monthly(totalCost, windowDays) * (0.5 - weighted) * 0.6),
      confidence: 0.4,
      effort: 2,
      score: 0,
      recommendation: `Across all of ${agentId}'s clusters, only ${(weighted * 100).toFixed(0)}% of input tokens hit the prompt cache (healthy agents exceed 50%). Stabilize the prompt prefix (system prompt, CLAUDE.md, tool definitions) so it stops churning between turns; cached reads cost 10% of fresh input.`,
      evidenceRunIds: agentClusters[0]?.runIds.slice(0, 5) ?? [],
      labelSequence: [],
      details: { cacheReadRatio: round(weighted), totalRuns }
    });
  }
  return findings;
}
function describeCluster(c) {
  const firstTool = c.labelSequence.find((l) => l.startsWith("tool:"));
  const prompt = c.runs[0]?.firstPrompt;
  if (prompt)
    return prompt.slice(0, 60).replace(/\s+/g, " ");
  if (firstTool)
    return firstTool.slice(0, 60);
  return c.clusterId;
}
function shortModel(m) {
  return m.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}
function mode(values) {
  const m = /* @__PURE__ */ new Map();
  for (const v of values)
    m.set(v, (m.get(v) ?? 0) + 1);
  let best = "";
  let bestN = -1;
  for (const [v, n] of m)
    if (n > bestN)
      best = v, bestN = n;
  return best;
}
function mapSegmentFindings(segments, windowDays) {
  const findings = [];
  for (const seg of segments) {
    if (seg.support < 3)
      continue;
    const monthlyCost = monthly(seg.totalCostUsd, windowDays);
    if (seg.determinism >= 0.9 && seg.mechanicalRatio >= 0.6) {
      findings.push({
        kind: "compile",
        title: `Compile segment: ${seg.length} steps repeated in ${seg.support}/${seg.runsTotal} runs (${(seg.mechanicalRatio * 100).toFixed(0)}% mechanical)`,
        agentId: "*",
        clusterIds: [],
        estMonthlySavingUsd: round(monthlyCost * 0.85),
        confidence: round(Math.min(0.95, seg.determinism * (0.6 + 0.4 * (seg.support / seg.runsTotal)))),
        effort: 2,
        score: 0,
        recommendation: `This ${seg.length}-step segment recurs in ${seg.support} of ${seg.runsTotal} runs (${seg.occurrences} occurrences, ~$${seg.avgCostPerOccurrenceUsd}/occurrence) and is ${(seg.determinism * 100).toFixed(0)}% deterministic. ${(seg.mechanicalRatio * 100).toFixed(0)}% of its steps are mechanical/cacheable \u2014 replace the segment with a plain script (a "meta-tool") and skip the LLM for it entirely.`,
        evidenceRunIds: seg.examples.map((e) => e.runId),
        labelSequence: seg.labels,
        details: { segment: { ...seg, classes: seg.classes } }
      });
    } else if (seg.determinism >= 0.7 && seg.mechanicalRatio >= 0.5) {
      findings.push({
        kind: "rightsize",
        title: `Route segment to a smaller model: ${seg.length} steps, ${seg.support}/${seg.runsTotal} runs`,
        agentId: "*",
        clusterIds: [],
        estMonthlySavingUsd: round(monthlyCost * 0.6),
        confidence: round(0.4 + 0.4 * seg.determinism),
        effort: 2,
        score: 0,
        recommendation: `This recurring segment is ${(seg.determinism * 100).toFixed(0)}% deterministic and mostly mechanical \u2014 not safe to fully script yet, but safe to route to a much smaller model (the decisions inside it are predictable) while the surrounding reasoning stays on the capable model.`,
        evidenceRunIds: seg.examples.map((e) => e.runId),
        labelSequence: seg.labels,
        details: { segment: { ...seg, classes: seg.classes } }
      });
    }
  }
  for (const f of findings)
    f.score = f.estMonthlySavingUsd * f.confidence / f.effort;
  return findings;
}
function mapFindings(clusters, options) {
  const { windowDays } = options;
  const all = [
    ...compileFindings(clusters, windowDays),
    ...cacheFindings(clusters, windowDays),
    ...rightsizeFindings(clusters, windowDays),
    ...fixFindings(clusters, windowDays),
    ...precomputeFindings(clusters, windowDays),
    ...alignFindings(clusters, windowDays)
  ];
  for (const f of all) {
    f.score = f.estMonthlySavingUsd * f.confidence / f.effort;
  }
  return all.filter((f) => f.estMonthlySavingUsd >= 0.01).sort((a, b) => b.score - a.score).slice(0, options.maxFindings ?? MAX_FINDINGS);
}

// packages/core/dist/segments.js
var import_node_crypto3 = require("node:crypto");

// packages/core/dist/taxonomy.js
var MECHANICAL_TOOLS = /* @__PURE__ */ new Set([
  "read",
  "glob",
  "grep",
  "ls",
  "notebookread",
  "toolsearch",
  "tasklist",
  "taskget"
]);
var CACHEABLE_TOOLS = /* @__PURE__ */ new Set(["webfetch", "web_fetch", "websearch", "web_search"]);
var SIDE_EFFECT_TOOLS = /* @__PURE__ */ new Set([
  "write",
  "edit",
  "multiedit",
  "notebookedit",
  "taskcreate",
  "taskupdate",
  "sendmessage"
]);
var GENERATIVE_TOOLS = /* @__PURE__ */ new Set(["task", "agent", "workflow", "skill", "advisor"]);
var RO_BASH = /^\s*(ls|cat|head|tail|wc|grep|rg|find|pwd|which|whoami|echo|printf|stat|du|df|ps|env|printenv|jq|yq|sort|uniq|cut|awk|sed -n|tr|diff|cmp|file|basename|dirname|realpath|readlink|md5|shasum|sha256sum|git (status|log|diff|show|branch|remote|rev-parse|describe|blame|ls-files)|npm (ls|view|outdated)|node --version|python3? --version|curl (-s+ )?-?-head|type)\b/i;
var FETCH_BASH = /^\s*(curl|wget|http)\b(?![^|]*(-X\s*(POST|PUT|DELETE|PATCH)|--data|-d\s))/i;
function classifyBashCommand(command) {
  const stages = command.split(/\||&&|;/).map((s) => s.trim()).filter(Boolean);
  let cls = "mechanical";
  for (const stage of stages) {
    if (RO_BASH.test(stage))
      continue;
    if (FETCH_BASH.test(stage)) {
      if (cls === "mechanical")
        cls = "cacheable";
      continue;
    }
    return "side_effect";
  }
  return cls;
}
function classifyStep(step) {
  if (step.kind === "model_turn" || step.kind === "thinking")
    return "generative";
  if (step.kind === "tool_result")
    return classifyStep({ ...step, kind: "tool_use" });
  const name = step.name.toLowerCase();
  if (MECHANICAL_TOOLS.has(name))
    return "mechanical";
  if (CACHEABLE_TOOLS.has(name))
    return "cacheable";
  if (SIDE_EFFECT_TOOLS.has(name))
    return "side_effect";
  if (GENERATIVE_TOOLS.has(name))
    return "generative";
  if (name === "bash" || name === "shell") {
    try {
      const input = JSON.parse(step.payload);
      if (typeof input.command === "string")
        return classifyBashCommand(input.command);
    } catch {
    }
    return "side_effect";
  }
  return "side_effect";
}
function classifyNode(node) {
  const name = node.label.startsWith("tool:") ? node.label.slice(5).split(" ")[0] : node.label.startsWith("result:") ? node.label.slice(7).split(" ")[0] : node.label.split(":")[0];
  const kind = node.label.startsWith("tool:") ? "tool_use" : node.label.startsWith("result:") ? "tool_result" : node.label === "thinking" ? "thinking" : "model_turn";
  return classifyStep({ kind, name, payload: node.raw });
}

// packages/core/dist/segments.js
var MIN_LEN = 3;
var MAX_LEN = 12;
var MAX_SEGMENTS = 12;
function attributeStepCosts(graph) {
  const weights = graph.nodes.map((n) => {
    const size = Math.max(50, n.raw.length);
    return n.kind === "model_turn" || n.kind === "thinking" ? size * 4 : size;
  });
  const total = weights.reduce((s, w) => s + w, 0) || 1;
  return weights.map((w) => graph.costUsd * w / total);
}
function mineSegments(graphs, maxSegments = MAX_SEGMENTS) {
  if (graphs.length < 2)
    return [];
  const stepCosts = new Map(graphs.map((g) => [g.runId, attributeStepCosts(g)]));
  const byKey = /* @__PURE__ */ new Map();
  for (const g of graphs) {
    const costs = stepCosts.get(g.runId);
    const seq = g.labelSequence;
    for (let n = MIN_LEN; n <= Math.min(MAX_LEN, seq.length); n++) {
      for (let i = 0; i + n <= seq.length; i++) {
        const labels = seq.slice(i, i + n);
        const key2 = (0, import_node_crypto3.createHash)("sha256").update(labels.join("\u241E")).digest("hex").slice(0, 16);
        const acc = byKey.get(key2) ?? byKey.set(key2, { labels, runs: /* @__PURE__ */ new Set(), occurrences: [] }).get(key2);
        acc.runs.add(g.runId);
        acc.occurrences.push({
          runId: g.runId,
          startIndex: i,
          costUsd: costs.slice(i, i + n).reduce((s, c) => s + c, 0),
          valueHash: (0, import_node_crypto3.createHash)("sha256").update(g.nodes.slice(i, i + n).map((nd) => nd.canonicalValue).join("\u241F")).digest("hex")
        });
      }
    }
  }
  const minSupport = Math.max(2, Math.ceil(graphs.length * 0.3));
  let candidates = [...byKey.values()].filter((a) => a.runs.size >= minSupport);
  const key = (labels) => labels.join("\u241E");
  const byJoined = new Map(candidates.map((c) => [key(c.labels), c]));
  candidates = candidates.filter((c) => {
    for (const other of byJoined.values()) {
      if (other.labels.length <= c.labels.length)
        continue;
      if (other.runs.size < c.runs.size)
        continue;
      if (key(other.labels).includes(key(c.labels)))
        return false;
    }
    return true;
  });
  const graphById = new Map(graphs.map((g) => [g.runId, g]));
  const segments = candidates.map((c) => {
    const totalCost = c.occurrences.reduce((s, o) => s + o.costUsd, 0);
    const hashCounts = /* @__PURE__ */ new Map();
    for (const o of c.occurrences)
      hashCounts.set(o.valueHash, (hashCounts.get(o.valueHash) ?? 0) + 1);
    const modal = Math.max(...hashCounts.values());
    const rep = c.occurrences[0];
    const repNodes = graphById.get(rep.runId).nodes.slice(rep.startIndex, rep.startIndex + c.labels.length);
    const classes = repNodes.map((n) => classifyNode(n));
    const nonGenerative = classes.filter((cl) => cl === "mechanical" || cl === "cacheable").length;
    const seen = /* @__PURE__ */ new Set();
    const examples = c.occurrences.filter((o) => seen.has(o.runId) ? false : (seen.add(o.runId), true)).slice(0, 5).map((o) => ({ runId: o.runId, startIndex: o.startIndex }));
    return {
      segmentId: (0, import_node_crypto3.createHash)("sha256").update(key(c.labels)).digest("hex").slice(0, 12),
      labels: c.labels,
      length: c.labels.length,
      support: c.runs.size,
      runsTotal: graphs.length,
      occurrences: c.occurrences.length,
      avgCostPerOccurrenceUsd: Math.round(totalCost / c.occurrences.length * 1e4) / 1e4,
      totalCostUsd: Math.round(totalCost * 100) / 100,
      determinism: Math.round(modal / c.occurrences.length * 100) / 100,
      mechanicalRatio: Math.round(nonGenerative / classes.length * 100) / 100,
      classes,
      examples
    };
  });
  return segments.sort((a, b) => b.totalCostUsd * b.support - a.totalCostUsd * a.support).slice(0, maxSegments);
}

// packages/core/dist/analyze.js
function windowDaysOf(graphs) {
  const dates = graphs.map((g) => g.startedAt).filter((d) => !!d).map((d) => Date.parse(d)).filter((t) => !Number.isNaN(t));
  if (dates.length < 2)
    return 1;
  const span = (Math.max(...dates) - Math.min(...dates)) / 864e5;
  return Math.max(1, span);
}
function analyzeRuns(runs, now) {
  const graphs = runs.map(buildRunGraph);
  const clusters = clusterRuns(graphs);
  const windowDays = windowDaysOf(graphs);
  const segments = mineSegments(graphs);
  const findings = [...mapFindings(clusters, { windowDays, maxFindings: 99 }), ...mapSegmentFindings(segments, windowDays)].sort((a, b) => b.score - a.score).slice(0, 5);
  const totalCost = graphs.reduce((s, g) => s + g.costUsd, 0);
  const clusteredRuns = clusters.filter((c) => c.metrics.nRuns >= 2).reduce((s, c) => s + c.metrics.nRuns, 0);
  const clusterSummaries = clusters.map((c) => ({
    clusterId: c.clusterId,
    agentId: c.agentId,
    familyId: c.familyId,
    nRuns: c.metrics.nRuns,
    totalCostUsd: Math.round(c.metrics.totalCostUsd * 100) / 100,
    determinismScore: Math.round(c.metrics.determinismScore * 100) / 100,
    failureRate: Math.round(c.metrics.failureRate * 100) / 100,
    labelSequence: c.labelSequence,
    runIds: c.runIds,
    modelMix: c.metrics.modelMix
  }));
  const report = {
    generatedAt: now ?? (/* @__PURE__ */ new Date()).toISOString(),
    agentIds: [...new Set(graphs.map((g) => g.agentId))].sort(),
    windowDays: Math.round(windowDays * 10) / 10,
    totals: {
      runs: graphs.length,
      costUsd: Math.round(totalCost * 100) / 100,
      estMonthlyCostUsd: Math.round(totalCost * (30 / windowDays) * 100) / 100,
      clusteredRunRatio: graphs.length === 0 ? 0 : Math.round(clusteredRuns / graphs.length * 100) / 100,
      cacheReadRatio: Math.round(cacheReadRatio(graphs.flatMap((g) => Object.values(g.usageByModel))) * 100) / 100
    },
    findings,
    clusters: clusterSummaries,
    segments
  };
  return { report, clusters, graphs };
}

// packages/core/dist/report.js
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function usd(n) {
  return n >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`;
}
var KIND_META = {
  compile: { badge: "COMPILE IT", color: "#7c5cff" },
  cache: { badge: "CACHE IT", color: "#00a37a" },
  rightsize: { badge: "RIGHT-SIZE IT", color: "#0b84ff" },
  fix: { badge: "FIX IT", color: "#e5484d" },
  precompute: { badge: "PRECOMPUTE IT", color: "#f5a623" },
  align: { badge: "ALIGN IT", color: "#8f8f8f" }
};
function chainSvg(labels) {
  if (labels.length === 0)
    return "";
  const BOX_W = 170;
  const BOX_H = 44;
  const GAP = 28;
  const PAD = 8;
  const width = labels.length * (BOX_W + GAP) - GAP + PAD * 2;
  const height = BOX_H + PAD * 2;
  const parts = [];
  labels.forEach((label, i) => {
    const x = PAD + i * (BOX_W + GAP);
    const y = PAD;
    const isTool = label.startsWith("tool:");
    const isResult = label.startsWith("result:");
    const isErr = / error /.test(label) || label.includes(" error");
    const fill = isErr ? "#fdecec" : isTool ? "#eef2ff" : isResult ? "#f0faf5" : "#f7f7f8";
    const stroke = isErr ? "#e5484d" : isTool ? "#7c5cff" : isResult ? "#00a37a" : "#c9c9cf";
    const text = label.length > 40 ? `${label.slice(0, 39)}\u2026` : label;
    parts.push(`<g><rect x="${x}" y="${y}" width="${BOX_W}" height="${BOX_H}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/><text x="${x + BOX_W / 2}" y="${y + BOX_H / 2 + 4}" font-size="10" font-family="ui-monospace,Menlo,monospace" text-anchor="middle" fill="#333">${esc(text)}</text></g>`);
    if (i < labels.length - 1) {
      const ax = x + BOX_W;
      const ay = y + BOX_H / 2;
      parts.push(`<line x1="${ax + 3}" y1="${ay}" x2="${ax + GAP - 8}" y2="${ay}" stroke="#9a9aa2" stroke-width="1.5"/><path d="M ${ax + GAP - 8} ${ay - 4} L ${ax + GAP - 1} ${ay} L ${ax + GAP - 8} ${ay + 4} Z" fill="#9a9aa2"/>`);
    }
  });
  return `<div style="overflow-x:auto"><svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join("")}</svg></div>`;
}
function findingCard(f, rank) {
  const meta = KIND_META[f.kind];
  return `
  <section class="finding">
    <div class="finding-head">
      <span class="rank">#${rank}</span>
      <span class="badge" style="background:${meta.color}">${meta.badge}</span>
      <span class="saving">${usd(f.estMonthlySavingUsd)}<small>/mo est.</small></span>
    </div>
    <h3>${esc(f.title)}</h3>
    <p class="rec">${esc(f.recommendation)}</p>
    ${f.labelSequence.length ? chainSvg(f.labelSequence) : ""}
    <div class="meta-row">
      <span>agent: <code>${esc(f.agentId)}</code></span>
      <span>confidence: ${(f.confidence * 100).toFixed(0)}%</span>
      <span>effort: ${"\u25CF".repeat(f.effort)}${"\u25CB".repeat(Math.max(0, 5 - f.effort))}</span>
    </div>
    <details>
      <summary>Evidence \u2014 ${f.evidenceRunIds.length} run(s)</summary>
      <ul class="evidence">${f.evidenceRunIds.map((id) => `<li><code>${esc(id)}</code></li>`).join("")}</ul>
    </details>
  </section>`;
}
function renderReportHtml(report, opts = {}) {
  const title = opts.title ?? "ccopt \u2014 Agent Waste Report";
  const t = report.totals;
  const topClusters = report.clusters.filter((c) => c.nRuns >= 2).slice(0, 12);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #fafafa; color: #1a1a1e; }
  .wrap { max-width: 980px; margin: 0 auto; padding: 32px 20px 80px; }
  header h1 { font-size: 26px; margin: 0 0 4px; }
  header .sub { color: #66666e; margin-bottom: 24px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 20px 0 32px; }
  .stat { background: #fff; border: 1px solid #e4e4e8; border-radius: 10px; padding: 14px 16px; }
  .stat .v { font-size: 22px; font-weight: 700; }
  .stat .k { font-size: 12px; color: #66666e; text-transform: uppercase; letter-spacing: .04em; }
  .finding { background: #fff; border: 1px solid #e4e4e8; border-radius: 12px; padding: 18px 20px; margin-bottom: 18px; }
  .finding-head { display: flex; align-items: center; gap: 10px; }
  .rank { font-weight: 800; color: #9a9aa2; }
  .badge { color: #fff; font-size: 11px; font-weight: 700; letter-spacing: .05em; padding: 3px 8px; border-radius: 6px; }
  .saving { margin-left: auto; font-size: 20px; font-weight: 800; color: #00794f; }
  .saving small { font-size: 11px; font-weight: 500; color: #66666e; }
  .finding h3 { margin: 10px 0 6px; font-size: 16px; }
  .rec { color: #3c3c44; font-size: 14px; line-height: 1.5; }
  .meta-row { display: flex; gap: 18px; font-size: 12px; color: #66666e; margin-top: 10px; flex-wrap: wrap; }
  details { margin-top: 10px; font-size: 13px; }
  summary { cursor: pointer; color: #55555e; }
  .evidence { columns: 2; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e4e4e8; border-radius: 12px; overflow: hidden; font-size: 13px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eee; }
  th { background: #f4f4f6; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #66666e; }
  td code { font-size: 11px; }
  .honesty { margin-top: 40px; padding: 16px 18px; background: #fff8e8; border: 1px solid #eedc9a; border-radius: 10px; font-size: 13px; color: #5c4d1e; line-height: 1.5; }
  h2 { margin: 36px 0 14px; font-size: 18px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>The Agent Waste Report</h1>
    <div class="sub">Generated ${esc(report.generatedAt)} \xB7 window ${report.windowDays} day(s) \xB7 agents: ${report.agentIds.map((a) => `<code>${esc(a)}</code>`).join(", ")}</div>
  </header>

  <div class="stats">
    <div class="stat"><div class="v">${report.totals.runs}</div><div class="k">runs analyzed</div></div>
    <div class="stat"><div class="v">${usd(t.costUsd)}</div><div class="k">observed spend</div></div>
    <div class="stat"><div class="v">${usd(t.estMonthlyCostUsd)}</div><div class="k">est. monthly spend</div></div>
    <div class="stat"><div class="v">${(t.clusteredRunRatio * 100).toFixed(0)}%</div><div class="k">runs in repeated shapes</div></div>
    <div class="stat"><div class="v">${(t.cacheReadRatio * 100).toFixed(0)}%</div><div class="k">prompt-cache read ratio</div></div>
  </div>

  <h2>Top findings (ranked by saving \xD7 confidence \xF7 effort)</h2>
  ${report.findings.length ? report.findings.map((f, i) => findingCard(f, i + 1)).join("\n") : "<p>No findings above threshold yet \u2014 keep collecting runs, or lower thresholds with more history.</p>"}

  <h2>Repeated procedure clusters</h2>
  <div style="overflow-x:auto">
  <table>
    <thead><tr><th>cluster</th><th>agent</th><th>runs</th><th>cost</th><th>determinism</th><th>failure</th><th>models</th></tr></thead>
    <tbody>
      ${topClusters.map((c) => `<tr><td><code>${esc(c.clusterId.slice(0, 28))}</code></td><td>${esc(c.agentId)}</td><td>${c.nRuns}</td><td>${usd(c.totalCostUsd)}</td><td>${(c.determinismScore * 100).toFixed(0)}%</td><td>${(c.failureRate * 100).toFixed(0)}%</td><td>${Object.keys(c.modelMix).map((m) => esc(m.replace(/^claude-/, ""))).join(", ")}</td></tr>`).join("")}
    </tbody>
  </table>
  </div>

  <div class="honesty">
    <strong>What this report can and can't prove.</strong> It proves <em>procedural repetition</em> \u2014
    the same canonical shape, N times \u2014 and prices it precisely from recorded token usage. It cannot
    prove a future run will stay deterministic; determinism is shown as a score, not a promise, and any
    compiled replacement should ship with replay validation and a rollback path.
  </div>
</div>
</body>
</html>`;
}

// packages/cli/src/store.ts
var import_node_fs = require("node:fs");
var import_node_os = require("node:os");
var import_node_path = require("node:path");
var CCOPT_HOME = (0, import_node_path.join)((0, import_node_os.homedir)(), ".ccopt");
var AGENT_MAP_PATH = (0, import_node_path.join)(CCOPT_HOME, "agent-map.json");
var CCOPT_STORE = (0, import_node_path.join)(CCOPT_HOME, "store");
function defaultSource() {
  return (0, import_node_path.join)((0, import_node_os.homedir)(), ".claude", "projects");
}
function defaultSources() {
  return [defaultSource(), CCOPT_STORE];
}
var AGENT_TAGS_DIR = (0, import_node_path.join)(CCOPT_HOME, "agent-map.d");
var CONFIG_PATH = (0, import_node_path.join)(CCOPT_HOME, "config.json");
function loadConfig() {
  try {
    const parsed = JSON.parse((0, import_node_fs.readFileSync)(CONFIG_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function saveConfig(config) {
  (0, import_node_fs.mkdirSync)(CCOPT_HOME, { recursive: true });
  (0, import_node_fs.writeFileSync)(CONFIG_PATH, JSON.stringify(config, null, 2));
}
function agentFromRules(cwd, rules) {
  if (!cwd || !rules) return void 0;
  for (const rule of rules) {
    try {
      if (new RegExp(rule.pattern).test(cwd)) return rule.agent;
    } catch {
    }
  }
  return void 0;
}
function sniffCwd(path, maxBytes = 65536) {
  let head;
  try {
    const fd = (0, import_node_fs.openSync)(path, "r");
    const buf = Buffer.alloc(maxBytes);
    const n = (0, import_node_fs.readSync)(fd, buf, 0, maxBytes, 0);
    (0, import_node_fs.closeSync)(fd);
    head = buf.subarray(0, n).toString("utf8");
  } catch {
    return void 0;
  }
  for (const line of head.split("\n")) {
    const m = line.match(/"cwd":"([^"]+)"/);
    if (m) return m[1];
  }
  return void 0;
}
function resolveAgentId(sessionId, path) {
  const map = loadAgentMap();
  if (map[sessionId]) return map[sessionId];
  return agentFromRules(sniffCwd(path), loadConfig().agentRules);
}
function loadAgentMap() {
  const map = {};
  try {
    Object.assign(map, JSON.parse((0, import_node_fs.readFileSync)(AGENT_MAP_PATH, "utf8")));
  } catch {
  }
  try {
    for (const f of (0, import_node_fs.readdirSync)(AGENT_TAGS_DIR)) {
      try {
        map[f] = (0, import_node_fs.readFileSync)((0, import_node_path.join)(AGENT_TAGS_DIR, f), "utf8").trim();
      } catch {
      }
    }
  } catch {
  }
  return map;
}
function tagSessions(sessionIds, agentId) {
  (0, import_node_fs.mkdirSync)(AGENT_TAGS_DIR, { recursive: true });
  for (const id of sessionIds) {
    if (!/^[\w-]+$/.test(id)) continue;
    (0, import_node_fs.writeFileSync)((0, import_node_path.join)(AGENT_TAGS_DIR, id), agentId);
  }
}
function discoverSessions(sourceDir) {
  const out = [];
  if (!(0, import_node_fs.existsSync)(sourceDir)) return out;
  const walk = (dir) => {
    for (const entry of (0, import_node_fs.readdirSync)(dir, { withFileTypes: true })) {
      const p = (0, import_node_path.join)(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && !entry.name.startsWith("agent-")) {
        out.push({
          path: p,
          sessionId: entry.name.replace(/\.jsonl$/, ""),
          mtimeMs: (0, import_node_fs.statSync)(p).mtimeMs
        });
      }
    }
  };
  walk(sourceDir);
  return out;
}
function loadRuns(sourceDirs, options = {}) {
  const dirs = Array.isArray(sourceDirs) ? sourceDirs : [sourceDirs];
  const agentMap = loadAgentMap();
  const config = loadConfig();
  const cutoff = options.sinceDays !== void 0 ? Date.now() - options.sinceDays * 864e5 : void 0;
  const runs = [];
  const seenSessions = /* @__PURE__ */ new Set();
  for (const session of dirs.flatMap(discoverSessions)) {
    if (seenSessions.has(session.sessionId)) continue;
    seenSessions.add(session.sessionId);
    if (cutoff !== void 0 && session.mtimeMs < cutoff) continue;
    let jsonl;
    try {
      jsonl = (0, import_node_fs.readFileSync)(session.path, "utf8");
    } catch {
      continue;
    }
    const run = parseTranscript(jsonl, {
      agentId: agentMap[session.sessionId] ?? agentFromRules(sniffCwd(session.path), config.agentRules)
    });
    if (!run) continue;
    if (options.minSteps !== void 0 && run.steps.length < options.minSteps) continue;
    if (options.agentFilter && !run.agentId.includes(options.agentFilter)) continue;
    runs.push(run);
  }
  return runs;
}

// packages/cli/src/upload.ts
var import_node_fs2 = require("node:fs");
var import_node_zlib = require("node:zlib");
async function uploadSessionFile(target, filePath, sessionId, agentId) {
  const body = (0, import_node_zlib.gzipSync)((0, import_node_fs2.readFileSync)(filePath));
  try {
    const res = await fetch(`${target.server.replace(/\/$/, "")}/api/v1/ingest`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${target.apiKey}`,
        "content-type": "application/octet-stream",
        "content-encoding": "gzip",
        "x-ccopt-session-id": sessionId,
        ...agentId ? { "x-ccopt-agent-id": agentId } : {}
      },
      body
    });
    return { ok: res.ok, status: res.status, detail: res.ok ? void 0 : await res.text() };
  } catch (err) {
    return { ok: false, status: 0, detail: err instanceof Error ? err.message : String(err) };
  }
}

// packages/cli/src/index.ts
var program2 = new Command();
program2.name("ccopt").description("ccopt \u2014 graph-based agent waste detection").version("0.1.0");
program2.command("analyze").description("Analyze local Claude Code transcripts and render the Waste Report").option("--source <dir...>", "transcript directories", defaultSources()).option("--days <n>", "analysis window in days", "30").option("--agent <substr>", "only include agents whose id contains this substring").option("--min-steps <n>", "ignore trivial sessions with fewer steps", "3").option("--out <file>", "HTML report output path", "ccopt-report.html").option("--json <file>", "JSON report output path", "ccopt-report.json").action((opts) => {
  const sources = Array.isArray(opts.source) ? opts.source : [opts.source];
  const runs = loadRuns(sources.map((s) => (0, import_node_path2.resolve)(s)), {
    sinceDays: Number(opts.days),
    agentFilter: opts.agent,
    minSteps: Number(opts.minSteps)
  });
  if (runs.length === 0) {
    console.error(`No runs found under ${opts.source} in the last ${opts.days} day(s).`);
    process.exitCode = 1;
    return;
  }
  const { report } = analyzeRuns(runs);
  (0, import_node_fs3.writeFileSync)((0, import_node_path2.resolve)(opts.out), renderReportHtml(report));
  (0, import_node_fs3.writeFileSync)((0, import_node_path2.resolve)(opts.json), JSON.stringify(report, null, 2));
  const total = report.totals;
  console.log(`Analyzed ${total.runs} runs across ${report.agentIds.length} agent(s).`);
  console.log(
    `Observed spend $${total.costUsd} (~$${total.estMonthlyCostUsd}/mo) \xB7 ${Math.round(total.clusteredRunRatio * 100)}% of runs repeat a known shape \xB7 cache-read ratio ${Math.round(total.cacheReadRatio * 100)}%`
  );
  for (const [i, f] of report.findings.entries()) {
    console.log(`  #${i + 1} [${f.kind}] $${f.estMonthlySavingUsd}/mo \u2014 ${f.title}`);
  }
  console.log(`Report: ${(0, import_node_path2.resolve)(opts.out)}`);
});
program2.command("login").description("Persist the ccopt server + API key (used as defaults by sync/run/doctor)").requiredOption("--server <url>", "ccopt server base URL").requiredOption("--key <apiKey>", "tenant API key").action(async (opts) => {
  const config = loadConfig();
  config.server = opts.server;
  config.apiKey = opts.key;
  saveConfig(config);
  try {
    const res = await fetch(`${opts.server.replace(/\/$/, "")}/api/v1/reports`, {
      headers: { authorization: `Bearer ${opts.key}` }
    });
    console.log(
      res.ok ? `Saved to ${CONFIG_PATH} \u2014 key verified against ${opts.server}.` : `Saved to ${CONFIG_PATH}, but the key was rejected (HTTP ${res.status}) \u2014 check it.`
    );
  } catch {
    console.log(`Saved to ${CONFIG_PATH} \u2014 server unreachable right now, will be used anyway.`);
  }
});
program2.command("invite").description("Print a one-line setup command for another developer (uses your login + rules)").option("--agent <substr>", "restrict their scheduled sync to this agent substring").action((opts) => {
  const config = loadConfig();
  if (!config.server || !config.apiKey) {
    console.error("Run `ccopt login` first \u2014 invite packages your server + key.");
    process.exitCode = 2;
    return;
  }
  const token = {
    v: 1,
    server: config.server,
    apiKey: config.apiKey,
    agentRules: config.agentRules,
    syncAgent: opts.agent
  };
  const encoded = Buffer.from(JSON.stringify(token)).toString("base64url");
  console.log("Send this ONE command to the developer (contains the workspace API key \u2014 share privately):\n");
  console.log(
    `  curl -fsSL https://raw.githubusercontent.com/SpectorHacked/ccopt/main/install.sh | sh -s -- --join ${encoded}
`
  );
  console.log("It installs ccopt, joins this workspace, schedules a 15-minute sync, and uploads their history.");
});
program2.command("join").description("Join a workspace from an invite token: config + schedule + first sync, in one shot").argument("<token>", "setup token from `ccopt invite`").action(async (rawToken) => {
  let token;
  try {
    token = JSON.parse(Buffer.from(rawToken, "base64url").toString("utf8"));
    if (token.v !== 1 || !token.server || !token.apiKey) throw new Error("missing fields");
  } catch {
    console.error("Invalid setup token. Ask for a fresh one via `ccopt invite`.");
    process.exitCode = 2;
    return;
  }
  const config = loadConfig();
  config.server = token.server;
  config.apiKey = token.apiKey;
  if (token.agentRules) config.agentRules = token.agentRules;
  saveConfig(config);
  console.log(`\u2713 workspace config saved (${token.server})`);
  try {
    const res = await fetch(`${token.server.replace(/\/$/, "")}/api/v1/reports`, {
      headers: { authorization: `Bearer ${token.apiKey}` }
    });
    console.log(res.ok ? "\u2713 server reachable, API key accepted" : `\u2717 server rejected the key (HTTP ${res.status})`);
    if (!res.ok) process.exitCode = 1;
  } catch (err) {
    console.log(`! server not reachable right now (${err instanceof Error ? err.message : err}) \u2014 sync will retry on schedule`);
  }
  const nodeBin = process.execPath;
  const ccoptBin = (0, import_node_path2.resolve)(process.argv[1]);
  const syncArgs = ["sync", ...token.syncAgent ? ["--agent", token.syncAgent] : [], "--days", "7"];
  if (process.platform === "darwin") {
    const plistPath = (0, import_node_path2.join)((0, import_node_os2.homedir)(), "Library", "LaunchAgents", "com.ccopt.sync.plist");
    const args = [nodeBin, ccoptBin, ...syncArgs];
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.ccopt.sync</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${a}</string>`).join("\n")}
  </array>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${(0, import_node_path2.join)(CCOPT_HOME, "sync.log")}</string>
  <key>StandardErrorPath</key><string>${(0, import_node_path2.join)(CCOPT_HOME, "sync.log")}</string>
</dict>
</plist>
`;
    (0, import_node_fs3.mkdirSync)((0, import_node_path2.dirname)(plistPath), { recursive: true });
    (0, import_node_fs3.mkdirSync)(CCOPT_HOME, { recursive: true });
    (0, import_node_fs3.writeFileSync)(plistPath, plist);
    const uid = process.getuid?.() ?? 501;
    (0, import_node_child_process.spawnSync)("launchctl", ["bootout", `gui/${uid}/com.ccopt.sync`], { stdio: "ignore" });
    const boot = (0, import_node_child_process.spawnSync)("launchctl", ["bootstrap", `gui/${uid}`, plistPath], { encoding: "utf8" });
    console.log(
      boot.status === 0 ? "\u2713 scheduled: launchd job com.ccopt.sync (every 15 min)" : `! could not load launchd job (${boot.stderr?.trim()}) \u2014 plist written to ${plistPath}`
    );
  } else {
    const cronLine = `*/15 * * * * ${nodeBin} ${ccoptBin} ${syncArgs.join(" ")} >> ${(0, import_node_path2.join)(CCOPT_HOME, "sync.log")} 2>&1`;
    const current = (0, import_node_child_process.spawnSync)("crontab", ["-l"], { encoding: "utf8" });
    const existing = current.status === 0 ? current.stdout : "";
    if (existing.includes("ccopt") && existing.includes("sync")) {
      console.log("\u2713 scheduled: crontab already has a ccopt sync entry");
    } else {
      const set = (0, import_node_child_process.spawnSync)("crontab", ["-"], { input: `${existing.trimEnd()}
${cronLine}
`, encoding: "utf8" });
      console.log(
        set.status === 0 ? "\u2713 scheduled: cron entry added (every 15 min)" : `! could not edit crontab \u2014 add this line yourself:
    ${cronLine}`
      );
    }
  }
  console.log("Uploading existing history\u2026");
  const first = (0, import_node_child_process.spawnSync)(nodeBin, [ccoptBin, ...syncArgs, "--days", "30"], { stdio: "inherit" });
  console.log(
    first.status === 0 ? "\nDone. This machine now reports to the workspace continuously." : "\nSetup saved; first sync failed (see above) \u2014 the schedule will retry every 15 minutes."
  );
});
program2.command("sync").description("Upload local session transcripts to the ccopt service").option("--server <url>", "ccopt server base URL (default: ccopt login config)").option("--key <apiKey>", "tenant API key (default: ccopt login config)").option("--source <dir...>", "transcript directories", defaultSources()).option("--days <n>", "only sync sessions modified in the last N days", "30").option("--agent <substr>", "only sync sessions whose resolved agentId contains this substring").option(
  "--all",
  "DANGER: also upload unattributed sessions (everything on this machine). Default is attributed-only: a session uploads only when a tag or agentRule claims it."
).action(async (opts) => {
  const config = loadConfig();
  const server = opts.server ?? process.env.CCOPT_SERVER ?? config.server;
  const apiKey = opts.key ?? process.env.CCOPT_API_KEY ?? config.apiKey;
  if (!server || !apiKey) {
    console.error("No server/key: pass --server/--key, set CCOPT_SERVER/CCOPT_API_KEY, or run `ccopt login`.");
    process.exitCode = 2;
    return;
  }
  const cutoff = Date.now() - Number(opts.days) * 864e5;
  const sourceDirs = Array.isArray(opts.source) ? opts.source : [opts.source];
  const seen = /* @__PURE__ */ new Set();
  const sessions = sourceDirs.flatMap((d) => discoverSessions((0, import_node_path2.resolve)(d))).filter((s) => s.mtimeMs >= cutoff).filter((s) => seen.has(s.sessionId) ? false : (seen.add(s.sessionId), true)).map((s) => ({ ...s, agentId: resolveAgentId(s.sessionId, s.path) })).filter((s) => opts.all ? true : s.agentId !== void 0).filter((s) => !opts.agent || (s.agentId ?? "").includes(opts.agent));
  if (sessions.length === 0) {
    console.error(
      "Nothing to sync. (Only attributed sessions upload \u2014 add an agentRule, use `ccopt tag`/`ccopt run`, or pass --all.)"
    );
    return;
  }
  const target = (0, import_node_crypto4.createHash)("sha256").update(`${server}|${apiKey}`).digest("hex").slice(0, 12);
  const statePath = `${CCOPT_HOME}/sync-state-${target}.json`;
  let state = {};
  try {
    state = JSON.parse((0, import_node_fs3.readFileSync)(statePath, "utf8"));
  } catch {
  }
  let uploaded = 0;
  let skipped = 0;
  for (const s of sessions) {
    if (state[s.sessionId] && state[s.sessionId] >= s.mtimeMs) {
      skipped++;
      continue;
    }
    const r = await uploadSessionFile(
      { server, apiKey },
      s.path,
      s.sessionId,
      s.agentId
    );
    if (!r.ok) {
      console.error(`  \u2717 ${s.sessionId}: HTTP ${r.status} ${r.detail ?? ""}`);
      continue;
    }
    state[s.sessionId] = s.mtimeMs;
    uploaded++;
  }
  (0, import_node_fs3.mkdirSync)(CCOPT_HOME, { recursive: true });
  (0, import_node_fs3.writeFileSync)(statePath, JSON.stringify(state, null, 2));
  console.log(`Synced ${uploaded} session(s), ${skipped} already up to date.`);
});
program2.command("doctor").description("Check that ccopt can capture, attribute, and (optionally) upload on this machine").option("--server <url>", "ccopt server to check (env CCOPT_SERVER)").option("--key <apiKey>", "tenant API key to verify (env CCOPT_API_KEY)").action(async (opts) => {
  let failures = 0;
  const ok = (msg) => console.log(`  \u2713 ${msg}`);
  const warn = (msg) => console.log(`  ! ${msg}`);
  const bad = (msg) => {
    console.log(`  \u2717 ${msg}`);
    failures++;
  };
  console.log("ccopt doctor\n");
  const major = Number(process.versions.node.split(".")[0]);
  major >= 20 ? ok(`node ${process.versions.node}`) : bad(`node ${process.versions.node} \u2014 need \u2265 20`);
  const claudeBin = (0, import_node_child_process.spawnSync)("claude", ["--version"], { encoding: "utf8" });
  claudeBin.status === 0 ? ok(`claude CLI ${claudeBin.stdout.trim()}`) : warn("claude CLI not on PATH (fine if your agent bundles the Agent SDK)");
  for (const src of defaultSources()) {
    if (!(0, import_node_fs3.existsSync)(src)) {
      warn(`no transcript store at ${src} yet (created on first agent run)`);
      continue;
    }
    const sessions = discoverSessions(src);
    const recent = sessions.filter((s) => Date.now() - s.mtimeMs < 30 * 864e5);
    ok(`${src}: ${sessions.length} session(s), ${recent.length} in the last 30 days`);
  }
  const runs = loadRuns(defaultSources(), { sinceDays: 30, minSteps: 1 });
  runs.length > 0 ? ok(`${runs.length} run(s) parse cleanly (${[...new Set(runs.map((r) => r.agentId))].length} agent id(s))`) : warn("no parseable runs in the last 30 days \u2014 run any Claude Code/Agent SDK agent first");
  const tags = Object.keys(loadAgentMap()).length;
  tags > 0 ? ok(`${tags} session(s) explicitly attributed via ccopt run/tag`) : warn("no explicit attributions yet \u2014 untagged runs fall back to their directory name");
  if (process.env.ANTHROPIC_API_KEY) ok("env auth: ANTHROPIC_API_KEY set (--isolated will work)");
  else if (process.env.CLAUDE_CODE_USE_BEDROCK || process.env.CLAUDE_CODE_USE_VERTEX)
    ok("env auth: Bedrock/Vertex configured (--isolated will work)");
  else
    warn(
      "no env-based auth detected \u2014 `ccopt run --isolated` needs ANTHROPIC_API_KEY (or Bedrock/Vertex); non-isolated capture works regardless"
    );
  const config = loadConfig();
  const server = opts.server ?? process.env.CCOPT_SERVER ?? config.server;
  const apiKey = opts.key ?? process.env.CCOPT_API_KEY ?? config.apiKey;
  if (server) {
    try {
      const health = await fetch(`${server.replace(/\/$/, "")}/healthz`);
      health.ok ? ok(`server reachable: ${server}`) : bad(`server unhealthy: HTTP ${health.status}`);
      if (apiKey) {
        const auth = await fetch(`${server.replace(/\/$/, "")}/api/v1/reports`, {
          headers: { authorization: `Bearer ${apiKey}` }
        });
        auth.ok ? ok("API key accepted") : bad(`API key rejected: HTTP ${auth.status}`);
      } else {
        warn("no API key provided \u2014 skipping auth check (set CCOPT_API_KEY)");
      }
    } catch (err) {
      bad(`cannot reach ${server}: ${err instanceof Error ? err.message : err}`);
    }
  } else {
    warn("no server configured \u2014 local-only mode (set CCOPT_SERVER to check upload path)");
  }
  console.log(failures === 0 ? "\nAll checks passed." : `
${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
});
program2.command("tag").description("Attribute existing session(s) to a logical agentId (for external harnesses)").requiredOption("--agent <id>", "logical agent id").argument("<sessionId...>", "Claude Code session id(s) to tag").action((sessionIds, opts) => {
  tagSessions(sessionIds, opts.agent);
  console.log(`Tagged ${sessionIds.length} session(s) as ${opts.agent}`);
});
program2.command("run").description(
  "Run ANY agent command tagged with an agentId (for CI/cron). Standalone: no changes to the wrapped agent \u2014 sessions written during the run are attributed and, with --server, uploaded straight from the runner (ephemeral-machine safe)."
).requiredOption("--agent <id>", "logical agent id for this run").option("--source <dir>", "transcript directory to watch (non-isolated mode)", defaultSource()).option(
  "--isolated",
  "run with a private CLAUDE_CONFIG_DIR: exact attribution, safe for concurrent agents. Requires env-based auth (ANTHROPIC_API_KEY / Bedrock / Vertex) or file-based credentials; macOS keychain logins do not carry over."
).option("--server <url>", "ccopt server to upload captured sessions to (env CCOPT_SERVER)").option("--key <apiKey>", "tenant API key for --server (env CCOPT_API_KEY)").allowUnknownOption(true).argument("<cmd...>", 'command to execute, e.g. -- claude -p "\u2026" or -- node my-agent.js').action(async (cmd, opts) => {
  const argv = [...cmd];
  const config = loadConfig();
  const server = opts.server ?? process.env.CCOPT_SERVER ?? config.server;
  const apiKey = opts.key ?? process.env.CCOPT_API_KEY ?? config.apiKey;
  if (server && !apiKey) {
    console.error("[ccopt] --server requires --key (or CCOPT_API_KEY)");
    process.exitCode = 2;
    return;
  }
  const preTagged = [];
  if (argv[0] === "claude" && !argv.includes("--session-id")) {
    const sessionId = (0, import_node_crypto4.randomUUID)();
    argv.splice(1, 0, "--session-id", sessionId);
    preTagged.push(sessionId);
  }
  const env = { ...process.env };
  let watchDir;
  let isoDir;
  if (opts.isolated) {
    isoDir = (0, import_node_fs3.mkdtempSync)((0, import_node_path2.join)((0, import_node_os2.tmpdir)(), "ccopt-run-"));
    env.CLAUDE_CONFIG_DIR = isoDir;
    for (const f of [".credentials.json"]) {
      const src = (0, import_node_path2.join)((0, import_node_os2.homedir)(), ".claude", f);
      if ((0, import_node_fs3.existsSync)(src)) (0, import_node_fs3.copyFileSync)(src, (0, import_node_path2.join)(isoDir, f));
    }
    const stateFile = (0, import_node_path2.join)((0, import_node_os2.homedir)(), ".claude.json");
    if ((0, import_node_fs3.existsSync)(stateFile)) (0, import_node_fs3.copyFileSync)(stateFile, (0, import_node_path2.join)(isoDir, ".claude.json"));
    watchDir = (0, import_node_path2.join)(isoDir, "projects");
  } else {
    watchDir = (0, import_node_path2.resolve)(opts.source);
  }
  const before = new Map(discoverSessions(watchDir).map((s) => [s.path, s.mtimeMs]));
  console.error(`[ccopt] agent=${opts.agent}${opts.isolated ? " isolated" : ""} watching=${watchDir}`);
  const res = (0, import_node_child_process.spawnSync)(argv[0], argv.slice(1), { stdio: "inherit", env });
  const produced = discoverSessions(watchDir).filter((s) => {
    const prev = before.get(s.path);
    return prev === void 0 || s.mtimeMs > prev;
  });
  const sessionIds = [.../* @__PURE__ */ new Set([...preTagged, ...produced.map((s) => s.sessionId)])];
  if (sessionIds.length > 0) tagSessions(sessionIds, opts.agent);
  if (server && apiKey) {
    let ok = 0;
    for (const s of produced) {
      const r = await uploadSessionFile({ server, apiKey }, s.path, s.sessionId, opts.agent);
      if (r.ok) ok++;
      else console.error(`[ccopt] upload failed for ${s.sessionId}: HTTP ${r.status} ${r.detail ?? ""}`);
    }
    console.error(`[ccopt] uploaded ${ok}/${produced.length} session(s) as ${opts.agent}`);
  }
  if (isoDir) {
    for (const s of produced) {
      const rel = s.path.slice(watchDir.length + 1);
      const dest = (0, import_node_path2.join)(CCOPT_STORE, rel);
      (0, import_node_fs3.mkdirSync)((0, import_node_path2.dirname)(dest), { recursive: true });
      (0, import_node_fs3.copyFileSync)(s.path, dest);
    }
    (0, import_node_fs3.rmSync)(isoDir, { recursive: true, force: true });
  }
  console.error(
    sessionIds.length > 0 ? `[ccopt] attributed ${sessionIds.length} session(s) to ${opts.agent}` : "[ccopt] no sessions observed during the run"
  );
  process.exitCode = res.status ?? 1;
});
program2.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
