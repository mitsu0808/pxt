/// <reference path="../../localtypings/pxtblockly.d.ts" />

import * as React from "react";
import * as pkg from "./package";
import * as core from "./core";
import * as srceditor from "./srceditor"
import * as compiler from "./compiler"
import * as sui from "./sui";
import * as data from "./data";
import * as baseToolbox from "./toolbox";

import CategoryMode = pxt.blocks.CategoryMode;
import Util = pxt.Util;
let lf = Util.lf

let iface: pxt.worker.Iface

export class Editor extends srceditor.Editor {
    editor: Blockly.Workspace;
    currFile: pkg.File;
    delayLoadXml: string;
    typeScriptSaveable: boolean;
    loadingXml: boolean;
    loadingXmlPromise: Promise<any>;
    blockInfo: pxtc.BlocksInfo;
    compilationResult: pxt.blocks.BlockCompilationResult;
    isFirstBlocklyLoad = true;
    currentCommentOrWarning: B.Comment | B.Warning;
    selectedEventGroup: string;
    currentHelpCardType: string;
    showToolboxCategories: CategoryMode = CategoryMode.Basic;
    cachedToolbox: string;
    filters: pxt.editor.ProjectFilters;
    extensions: pxt.PackageConfig[];
    showSearch: boolean;

    setVisible(v: boolean) {
        super.setVisible(v);
        this.isVisible = v;
        let classes = '#blocksEditor .blocklyToolboxDiv, #blocksEditor .blocklyWidgetDiv, #blocksEditor .blocklyToolboxDiv';
        if (this.isVisible) {
            $(classes).show();
            // Fire a resize event since the toolbox may have changed width and height.
            this.parent.fireResize();
        }
        else {
            $(classes).hide();
            Blockly.hideChaff();
        }
    }

    saveToTypeScript(): Promise<string> {
        if (!this.typeScriptSaveable) return Promise.resolve('');
        this.clearHighlightedStatements();
        try {
            return pxt.blocks.compileAsync(this.editor, this.blockInfo)
                .then((compilationResult) => {
                    this.compilationResult = compilationResult;
                    pxt.tickActivity("blocks.compile");
                    return this.compilationResult.source;
                });
        } catch (e) {
            pxt.reportException(e)
            core.errorNotification(lf("Sorry, we were not able to convert this program."))
            return Promise.resolve('');
        }
    }

    updateBlocksInfo(bi: pxtc.BlocksInfo) {
        this.blockInfo = bi;
        this.refreshToolbox();
    }

    domUpdate() {
        if (this.delayLoadXml) {
            if (this.loadingXml) return
            pxt.debug(`loading blockly`)
            this.loadingXml = true

            let loading = document.createElement("div");
            loading.className = "ui inverted loading";
            let editorArea = document.getElementById('blocksArea');
            let editorDiv = document.getElementById("blocksEditor");
            editorDiv.appendChild(loading);

            this.loadingXmlPromise = compiler.getBlocksAsync()
                .then(bi => {
                    this.blockInfo = bi;
                    let showSearch = this.showSearch;
                    let toolbox = this.getDefaultToolbox(this.showToolboxCategories);

                    // Search needs a toolbox with ALL blocks
                    let tbAll: Element;
                    if (this.showToolboxCategories === CategoryMode.Basic) {
                        tbAll = pxt.blocks.initBlocks(this.blockInfo, toolbox, CategoryMode.All, this.filters, this.extensions);
                    }

                    let tb = pxt.blocks.initBlocks(this.blockInfo, toolbox, this.showToolboxCategories, this.filters, this.extensions);
                    this.updateToolbox(tb, this.showToolboxCategories);
                    if (this.showToolboxCategories !== CategoryMode.None && showSearch) {
                        pxt.blocks.initSearch(this.editor, tb, tbAll || tb,
                            searchFor => compiler.apiSearchAsync(searchFor)
                                .then((fns: pxtc.service.SearchInfo[]) => fns),
                            searchTb => this.updateToolbox(searchTb, this.showToolboxCategories, true));
                    } else {
                        pxt.blocks.removeSearch();
                    }
                    pxt.blocks.initFlyouts(this.editor);
                    // Register extension callbacks
                    pxt.blocks.initExtensions(this.editor, this.extensions, (extensionName) => {
                        const extension = this.extensions.filter(c => c.name == extensionName)[0];
                        const parsedRepo = pxt.github.parseRepoId(extension.installedVersion);
                        pxt.packagesConfigAsync()
                            .then((config) => {
                                const repoStatus = pxt.github.repoStatus(parsedRepo, config);
                                const repoName = parsedRepo.fullName.substr(parsedRepo.fullName.indexOf(`/`) + 1);
                                const localDebug = pxt.Cloud.isLocalHost() && /^file:/.test(extension.installedVersion) && extension.extension.localUrl;
                                const debug = pxt.Cloud.isLocalHost() && /debugExtensions/i.test(window.location.href);
                                const url = debug ? "http://localhost:3232/extension.html"
                                    : localDebug ? extension.extension.localUrl : `https://${parsedRepo.owner}.github.io/${repoName}/`;
                                this.parent.openExtension(extension.name, url, repoStatus == 0); // repoStatus can only be APPROVED or UNKNOWN at this point
                            });
                    })

                    pxt.debug(`loading block workspace`)
                    let xml = this.delayLoadXml;
                    this.delayLoadXml = undefined;
                    this.loadBlockly(xml);

                    this.resize();
                    Blockly.svgResize(this.editor);
                    this.isFirstBlocklyLoad = false;
                }).finally(() => {
                    this.loadingXml = false
                    editorDiv.removeChild(loading);
                    core.hideLoading("loadingblocks");
                });

            if (this.isFirstBlocklyLoad) {
                core.showLoadingAsync("loadingblocks", lf("loading..."), this.loadingXmlPromise).done();
            } else {
                this.loadingXmlPromise.done();
            }
            this.loadingXmlPromise = null;
        }
    }

    private saveBlockly(): string {
        // make sure we don't return an empty document before we get started
        // otherwise it may get saved and we're in trouble
        if (this.delayLoadXml) return this.delayLoadXml;
        return this.serializeBlocks();
    }

    private serializeBlocks(normalize?: boolean): string {
        let xml = pxt.blocks.saveWorkspaceXml(this.editor);
        // strip out id, x, y attributes
        if (normalize) xml = xml.replace(/(x|y|id)="[^"]*"/g, '')
        pxt.debug(xml)
        return xml;
    }

    private loadBlockly(s: string): boolean {
        if (this.serializeBlocks() == s) {
            this.typeScriptSaveable = true;
            pxt.debug('blocks already loaded...');
            return false;
        }

        this.typeScriptSaveable = false;
        this.editor.clear();
        try {
            const text = pxt.blocks.importXml(s || `<block type="${ts.pxtc.ON_START_TYPE}"></block>`, this.blockInfo, true);
            const xml = Blockly.Xml.textToDom(text);
            Blockly.Xml.domToWorkspace(xml, this.editor);

            this.initLayout();
            this.editor.clearUndo();
            this.reportDeprecatedBlocks();

            this.typeScriptSaveable = true;
        } catch (e) {
            pxt.log(e);
            this.editor.clear();
            this.switchToTypeScript();
            this.changeCallback();
            return false;
        }

        this.changeCallback();

        return true;
    }

    private initLayout() {
        let minX: number;
        let minY: number;
        let needsLayout = false;
        let flyoutOnly = !(this.editor as any).toolbox_ && (this.editor as any).flyout_;

        this.editor.getTopBlocks(false).forEach(b => {
            const tp = b.getBoundingRectangle().topLeft;
            if (minX === undefined || tp.x < minX) {
                minX = tp.x;
            }
            if (minY === undefined || tp.y < minY) {
                minY = tp.y;
            }

            needsLayout = needsLayout || (b.type != ts.pxtc.ON_START_TYPE && tp.x == 0 && tp.y == 0);
        });

        if (needsLayout && !flyoutOnly) {
            // If the blocks file has no location info (e.g. it's from the decompiler), format the code.
            pxt.blocks.layout.flow(this.editor, { useViewWidth: true });
        }
        else {
            // Otherwise translate the blocks so that they are positioned on the top left
            this.editor.getTopBlocks(false).forEach(b => b.moveBy(-minX, -minY));
            this.editor.scrollX = flyoutOnly ? (this.editor as any).flyout_.width_ + 10 : 10;
            this.editor.scrollY = 10;

            // Forces scroll to take effect
            this.editor.resizeContents();
        }
    }

    private initPrompts() {
        // Overriding blockly prompts to use semantic modals

        /**
         * Wrapper to window.alert() that app developers may override to
         * provide alternatives to the modal browser window.
         * @param {string} message The message to display to the user.
         * @param {function()=} opt_callback The callback when the alert is dismissed.
         */
        Blockly.alert = function (message, opt_callback) {
            return core.confirmAsync({
                hideCancel: true,
                header: lf("Alert"),
                agreeLbl: lf("Ok"),
                agreeClass: "positive",
                agreeIcon: "checkmark",
                body: message,
                size: "tiny"
            }).then(() => {
                if (opt_callback) {
                    opt_callback();
                }
            })
        };

        /**
         * Wrapper to window.confirm() that app developers may override to
         * provide alternatives to the modal browser window.
         * @param {string} message The message to display to the user.
         * @param {!function(boolean)} callback The callback for handling user response.
         */
        Blockly.confirm = function (message, callback) {
            return core.confirmAsync({
                header: lf("Confirm"),
                body: message,
                agreeLbl: lf("Yes"),
                agreeClass: "cancel",
                agreeIcon: "cancel",
                disagreeLbl: lf("No"),
                disagreeClass: "positive",
                disagreeIcon: "checkmark",
                size: "tiny"
            }).then(b => {
                callback(b == 1);
            })
        };

        /**
         * Wrapper to window.prompt() that app developers may override to provide
         * alternatives to the modal browser window. Built-in browser prompts are
         * often used for better text input experience on mobile device. We strongly
         * recommend testing mobile when overriding this.
         * @param {string} message The message to display to the user.
         * @param {string} defaultValue The value to initialize the prompt with.
         * @param {!function(string)} callback The callback for handling user reponse.
         */
        Blockly.prompt = function (message, defaultValue, callback) {
            return core.promptAsync({
                header: message,
                defaultValue: defaultValue,
                agreeLbl: lf("Ok"),
                disagreeLbl: lf("Cancel"),
                size: "tiny"
            }).then(value => {
                callback(value);
            })
        };
    }

    private initToolboxPosition() {
        let editor = this;
        /**
         * Move the toolbox to the edge.
         */
        const oldToolboxPosition = (Blockly as any).Toolbox.prototype.position;
        (Blockly as any).Toolbox.prototype.position = function () {
            oldToolboxPosition.call(this);
            editor.resizeToolbox();
        }
    }

    private reportDeprecatedBlocks() {
        const deprecatedMap: pxt.Map<number> = {};
        let deprecatedBlocksFound = false;

        this.blockInfo.blocks.forEach(symbolInfo => {
            if (symbolInfo.attributes.deprecated) {
                deprecatedMap[symbolInfo.attributes.blockId] = 0;
            }
        });

        this.editor.getAllBlocks().forEach(block => {
            if (deprecatedMap[block.type] >= 0) {
                deprecatedMap[block.type]++;
                deprecatedBlocksFound = true;
            }
        });

        for (const block in deprecatedMap) {
            if (deprecatedMap[block] === 0) {
                delete deprecatedMap[block];
            }
        }

        if (deprecatedBlocksFound) {
            pxt.tickEvent("blocks.usingDeprecated", deprecatedMap);
        }
    }

    public contentSize(): { height: number; width: number } {
        return this.editor ? pxt.blocks.blocksMetrics(this.editor) : undefined;
    }

    /**
     * Takes the XML definition of the block that will be shown on the help card and modifies the XML
     * so that the field names are updated to match any field names of dropdowns on the selected block
     */
    private updateFields(originalXML: string, newFieldValues?: any, mutation?: Element): string {
        let parser = new DOMParser();
        let doc = parser.parseFromString(originalXML, "application/xml");
        let blocks = doc.getElementsByTagName("block");
        if (blocks.length >= 1) {
            //Setting innerText doesn't work if there are no children on the node
            let setInnerText = (c: any, newValue: string) => {
                //Remove any existing children
                while (c.firstChild) {
                    c.removeChild(c.firstChild);
                }
                let tn = doc.createTextNode(newValue);
                c.appendChild(tn)
            };

            let block = blocks[0];

            if (newFieldValues) {
                //Depending on the source, the nodeName may be capitalised
                let fieldNodes = Array.prototype.filter.call(block.childNodes, (c: any) => c.nodeName == 'field' || c.nodeName == 'FIELD');

                for (let i = 0; i < fieldNodes.length; i++) {
                    if (newFieldValues.hasOwnProperty(fieldNodes[i].getAttribute('name'))) {
                        setInnerText(fieldNodes[i], newFieldValues[fieldNodes[i].getAttribute('name')]);
                        delete newFieldValues[fieldNodes[i].getAttribute('name')];
                    }
                }

                //Now that existing field values have been reset, we can create new field values as appropriate
                for (let p in newFieldValues) {
                    let c = doc.createElement('field');
                    c.setAttribute('name', p);
                    setInnerText(c, newFieldValues[p]);
                    block.appendChild(c);
                }
            }
            else if (mutation) {
                const existingMutation = Array.prototype.filter.call(block.childNodes, (c: any) => c.nodeName == 'mutation' || c.nodeName == 'MUTATION');
                if (existingMutation.length) {
                    block.replaceChild(mutation, existingMutation[0]);
                }
                else {
                    block.appendChild(mutation);
                }
            }

            let serializer = new XMLSerializer();
            return serializer.serializeToString(doc);
        }
        else {
            return originalXML;
        }
    }

    isIncomplete() {
        return this.editor ? this.editor.isDragging() : false;
    }

    prepare() {
        pxt.blocks.openHelpUrl = (url: string) => {
            pxt.tickEvent("blocks.help", { url }, { interactiveConsent: true });
            const m = /^\/pkg\/([^#]+)#(.+)$/.exec(url);
            if (m) {
                const dep = pkg.mainPkg.deps[m[1]];
                if (dep && dep.verProtocol() == "github") {
                    // rewrite url to point to current endpoint
                    url = `/pkg/${dep.verArgument().replace(/#.*$/, '')}#${m[2]}`;
                    window.open(url, m[1]);
                    return; // TODO support serving package docs in docs frame.
                }
            };
            if (/^\//.test(url))
                this.parent.setSideDoc(url);
            else window.open(url, 'docs');
        }

        this.prepareBlockly();

        this.isReady = true
    }

    private prepareBlockly(showCategories?: CategoryMode) {
        let blocklyDiv = document.getElementById('blocksEditor');
        blocklyDiv.innerHTML = '';
        this.editor = Blockly.inject(blocklyDiv, this.getBlocklyOptions(showCategories));
        // set Blockly Colors
        let blocklyColors = (Blockly as any).Colours;
        Util.jsonMergeFrom(blocklyColors, pxt.appTarget.appTheme.blocklyColors || {});
        (Blockly as any).Colours = blocklyColors;
        this.editor.addChangeListener((ev) => {
            Blockly.Events.disableOrphans(ev);
            if (ev.type != 'ui') {
                this.changeCallback();
            }
            if (ev.type == 'create') {
                let lastCategory = (this.editor as any).toolbox_ ?
                    ((this.editor as any).toolbox_.lastCategory_ ?
                        (this.editor as any).toolbox_.lastCategory_.element_.innerText.trim()
                        : 'unknown')
                    : 'flyout';
                let blockId = ev.xml.getAttribute('type');
                pxt.tickActivity("blocks.create", "blocks.create." + blockId);
                if (ev.xml.tagName == 'SHADOW')
                    this.cleanUpShadowBlocks();
                this.parent.setState({ hideEditorFloats: false });
            }
            if (ev.type == 'ui') {
                if (ev.element == 'category') {
                    let toolboxVisible = !!ev.newValue;
                    if (toolboxVisible) {
                        // WARNING! Because we use the category open/close event to dismiss
                        // the cookie banner, be careful when manipulating the toolbox to make
                        // sure that this event only fires as the result of user action. Use
                        // Blockly.Events.disable() and Blockly.Events.enable() to prevent
                        // UI events from firing.
                        pxt.analytics.enableCookies();
                    }
                    this.parent.setState({ hideEditorFloats: toolboxVisible });
                    if (ev.newValue == pxt.blocks.addPackageTitle()) {
                        this.addPackage();
                    }
                    else if (ev.newValue == pxt.blocks.advancedTitle()) {
                        if (this.showToolboxCategories === CategoryMode.All) {
                            this.showToolboxCategories = CategoryMode.Basic;
                        }
                        else if (this.showToolboxCategories === CategoryMode.Basic) {
                            this.showToolboxCategories = CategoryMode.All;
                        }
                        this.refreshToolbox();
                    }
                }
                else if (ev.element == 'commentOpen'
                    || ev.element == 'warningOpen') {
                    /*
                     * We override the default selection behavior so that when a block is selected, its
                     * comment is expanded. However, if a user selects a block by clicking on its comment
                     * icon (the blue question mark), there is a chance that the comment will be expanded
                     * and immediately collapse again because the icon click toggled the state. This hack
                     * prevents two events caused by the same click from opening and then closing a comment
                     */
                    if (ev.group) {
                        // newValue is true if the comment has been expanded
                        if (ev.newValue) {
                            this.selectedEventGroup = ev.group
                        }
                        else if (ev.group == this.selectedEventGroup && this.currentCommentOrWarning) {
                            this.currentCommentOrWarning.setVisible(true)
                            this.selectedEventGroup = undefined
                        }
                    }
                }
                else if (ev.element == 'selected') {
                    if (this.currentCommentOrWarning) {
                        this.currentCommentOrWarning.setVisible(false)
                    }
                    const selected = Blockly.selected
                    if (selected && selected.warning && typeof (selected.warning) !== "string") {
                        (selected.warning as Blockly.Icon).setVisible(true)
                        this.currentCommentOrWarning = selected.warning
                    } else if (selected && selected.comment && typeof (selected.comment) !== "string") {
                        (selected.comment as Blockly.Icon).setVisible(true)
                        this.currentCommentOrWarning = selected.comment
                    }
                }
            }
        })
        this.initPrompts();
        this.initToolboxPosition();
        this.resize();
    }

    resize(e?: Event) {
        const blocklyArea = document.getElementById('blocksArea');
        const blocklyDiv = document.getElementById('blocksEditor');
        // Position blocklyDiv over blocklyArea.
        if (blocklyArea && blocklyDiv && this.editor) {
            blocklyDiv.style.width = blocklyArea.offsetWidth + 'px';
            blocklyDiv.style.height = blocklyArea.offsetHeight + 'px';
            Blockly.svgResize(this.editor);
            this.resizeToolbox();
        }
    }

    resizeToolbox() {
        const blocklyDiv = document.getElementById('blocksEditor');
        if (!blocklyDiv) return;
        const blocklyToolbox = blocklyDiv.getElementsByClassName('blocklyToolboxDiv')[0] as HTMLDivElement;
        if (!blocklyToolbox) return;
        this.parent.updateEditorLogo(blocklyToolbox.clientWidth);

        const blocklyOptions = this.getBlocklyOptions(this.showToolboxCategories);
        let toolboxHeight = blocklyDiv.offsetHeight;
        if (!(blocklyOptions as any).horizontalLayout) blocklyToolbox.style.height = `${toolboxHeight}px`;
    }

    hasUndo() {
        return this.editor ? this.editor.undoStack_.length != 0 : false;
    }

    undo() {
        if (!this.editor) return;
        this.editor.undo();
        this.parent.forceUpdate();
    }

    hasRedo() {
        return this.editor ? this.editor.redoStack_.length != 0 : false;
    }

    redo() {
        if (!this.editor) return;
        this.editor.undo(true);
        this.parent.forceUpdate();
    }

    zoomIn() {
        if (!this.editor) return;
        this.editor.zoomCenter(2);
    }

    zoomOut() {
        if (!this.editor) return;
        this.editor.zoomCenter(-2);
    }

    setScale(scale: number) {
        if (!this.editor) return;
        if (scale != (this.editor as any).scale) {
            (this.editor as any).setScale(scale);
        }
    }

    closeFlyout() {
        if (!this.editor) return;
        Blockly.hideChaff();
    }

    getId() {
        return "blocksArea"
    }

    display() {
        return (
            <div>
                <div id="blocksEditor"></div>
            </div>
        )
    }

    addPackage() {
        pxt.tickEvent("blocks.addpackage");
        (this.editor as any).toolbox_.clearSelection();
        this.parent.addPackage();
    }

    getViewState() {
        // ZOOM etc
        return {}
    }

    setViewState(pos: {}) { }

    getCurrentSource() {
        return this.editor && !this.delayLoadXml ? this.saveBlockly() : this.currSource;
    }

    acceptsFile(file: pkg.File) {
        return file.getExtension() == "blocks"
    }

    overrideFile(content: string) {
        if (this.delayLoadXml) {
            this.delayLoadXml = content;
            this.currSource = content;
        } else {
            this.loadBlockly(content);
        }
    }

    loadFileAsync(file: pkg.File): Promise<void> {
        Util.assert(!this.delayLoadXml);
        Util.assert(!this.loadingXmlPromise);

        this.blockInfo = undefined;
        this.currSource = file.content;
        this.typeScriptSaveable = false;
        this.setDiagnostics(file)
        this.delayLoadXml = file.content;
        this.editor.clear();
        this.editor.clearUndo();

        if (this.currFile && this.currFile != file) {
            this.filterToolbox(null);
        }
        if (this.parent.state.editorState && this.parent.state.editorState.filters) {
            this.filterToolbox(this.parent.state.editorState.filters);
        } else {
            this.filters = null;
        }
        if (this.parent.state.editorState && this.parent.state.editorState.searchBar != undefined) {
            this.showSearch = this.parent.state.editorState.searchBar;
        } else {
            this.showSearch = true;
        }
        if (this.parent.state.editorState && this.parent.state.editorState.hasCategories != undefined) {
            this.showToolboxCategories = this.parent.state.editorState.hasCategories ? CategoryMode.Basic : CategoryMode.None;
        } else {
            this.showToolboxCategories = CategoryMode.Basic;
        }
        this.currFile = file;
        // Clear the search field if a value exists
        let searchField = document.getElementById('blocklySearchInputField') as HTMLInputElement;
        if (searchField && searchField.value) {
            searchField.value = '';
        }
        // Get extension packages
        this.extensions = pkg.allEditorPkgs()
            .map(ep => ep.getKsPkg()).map(p => !!p && p.config)
            // Make sure the package has extensions enabled, and is a github package.
            // Extensions are limited to github packages and ghpages, as we infer their url from the installedVersion config
            .filter(config => !!config && !!config.extension && /^(file:|github:)/.test(config.installedVersion));

        return Promise.resolve();
    }

    public switchToTypeScript() {
        pxt.tickEvent("blocks.switchjavascript");
        this.parent.closeFlyout();
        this.parent.switchTypeScript();
    }

    setDiagnostics(file: pkg.File) {
        Util.assert(this.editor != undefined); // Guarded
        if (!this.compilationResult || this.delayLoadXml || this.loadingXml)
            return;

        // clear previous warnings on non-disabled blocks
        this.editor.getAllBlocks().filter(b => !b.disabled).forEach(b => b.setWarningText(null));
        let tsfile = file.epkg.files[file.getVirtualFileName()];
        if (!tsfile || !tsfile.diagnostics) return;

        // only show errors
        let diags = tsfile.diagnostics.filter(d => d.category == ts.pxtc.DiagnosticCategory.Error);
        let sourceMap = this.compilationResult.sourceMap;

        diags.filter(diag => diag.category == ts.pxtc.DiagnosticCategory.Error).forEach(diag => {
            let bid = pxt.blocks.findBlockId(sourceMap, { start: diag.line, length: 0 });
            if (bid) {
                let b = this.editor.getBlockById(bid)
                if (b) {
                    let txt = ts.pxtc.flattenDiagnosticMessageText(diag.messageText, "\n");
                    b.setWarningText(txt);
                }
            }
        })
    }

    highlightStatement(brk: pxtc.LocationInfo) {
        if (!this.compilationResult || this.delayLoadXml || this.loadingXml)
            return;
        if (brk) {
            let bid = pxt.blocks.findBlockId(this.compilationResult.sourceMap, { start: brk.line, length: brk.endLine - brk.line });
            if (bid) {
                this.editor.highlightBlock(bid);
            }
        }
    }

    clearHighlightedStatements() {
        this.editor.highlightBlock(null);
    }

    openTypeScript() {
        pxt.tickEvent("blocks.showjavascript");
        this.parent.closeFlyout();
        this.parent.openTypeScriptAsync().done();
    }

    private cleanUpShadowBlocks() {
        const blocks = this.editor.getTopBlocks(false);
        blocks.filter(b => b.isShadow_).forEach(b => b.dispose(false));
    }

    private getBlocklyOptions(showCategories?: CategoryMode) {
        let blocklyOptions = this.getDefaultOptions();
        Util.jsonMergeFrom(blocklyOptions, pxt.appTarget.appTheme.blocklyOptions || {});
        const hasCategories = showCategories ? showCategories !== CategoryMode.None :
            (blocklyOptions.hasCategories != undefined ? blocklyOptions.hasCategories : this.showToolboxCategories);
        (blocklyOptions as any).hasCategories = hasCategories;
        const toolbox = hasCategories ?
            document.getElementById('blocklyToolboxDefinitionCategory')
            : document.getElementById('blocklyToolboxDefinitionFlyout');
        blocklyOptions['toolbox'] = blocklyOptions.toolbox != undefined ?
            blocklyOptions.toolbox : blocklyOptions.readOnly ? undefined : toolbox;
        return blocklyOptions;
    }

    private getDefaultOptions() {
        const readOnly = pxt.shell.isReadOnly();
        const blocklyOptions: Blockly.Options = {
            scrollbars: true,
            media: pxt.webConfig.commitCdnUrl + "blockly/media/",
            sound: true,
            trashcan: false,
            collapse: false,
            comments: true,
            disable: false,
            readOnly: readOnly,
            toolboxOptions: {
                colour: pxt.appTarget.appTheme.coloredToolbox,
                inverted: pxt.appTarget.appTheme.invertedToolbox
            },
            zoom: {
                enabled: false,
                controls: false,
                wheel: true,
                maxScale: 2.5,
                minScale: .2,
                scaleSpeed: 1.05,
                startScale: pxt.BrowserUtils.isMobile() ? 0.7 : 0.8
            },
            rtl: Util.isUserLanguageRtl()
        };
        return blocklyOptions;
    }

    private getDefaultToolbox(showCategories = this.showToolboxCategories): HTMLElement {
        return showCategories !== CategoryMode.None ?
            baseToolbox.getBaseToolboxDom().documentElement
            :  baseToolbox.getBaseNoCategoryToolboxDom().documentElement;
    }

    filterToolbox(filters?: pxt.editor.ProjectFilters, showCategories = this.showToolboxCategories): Element {
        this.filters = filters;
        this.showToolboxCategories = showCategories;
        return this.refreshToolbox();
    }

    private refreshToolbox() {
        if (!this.blockInfo) return undefined;

        let toolbox = this.getDefaultToolbox(this.showToolboxCategories);
        let tbAll: Element;

        if (this.showToolboxCategories !== CategoryMode.All) {
            tbAll = pxt.blocks.createToolbox(this.blockInfo, toolbox, CategoryMode.All, this.filters, this.extensions);
        }
        let tb = pxt.blocks.createToolbox(this.blockInfo, toolbox, this.showToolboxCategories, this.filters, this.extensions);
        this.updateToolbox(tb, this.showToolboxCategories);

        pxt.blocks.cachedSearchTb = tb;
        pxt.blocks.cachedSearchTbAll = tbAll || tb;
        return tb;
    }

    private updateToolbox(tb: Element, showCategories = this.showToolboxCategories, search = false) {
        // no toolbox when readonly
        if (pxt.shell.isReadOnly()) return;

        pxt.debug('updating toolbox');
        const editor_ = (this.editor as any);
        if ((editor_.toolbox_ && showCategories !== CategoryMode.None) || (editor_.flyout_ && showCategories === CategoryMode.None)) {
            // Toolbox is consistent with current mode, safe to update
            let tbString = new XMLSerializer().serializeToString(tb);
            if (tbString == this.cachedToolbox) return;
            this.cachedToolbox = tbString;
            this.editor.updateToolbox(tb);

            // We need to set the toolbox's selected item to null so that it doesn't
            // try to send key events to a category that no longer exists (exception)
            if (!search && editor_.toolbox_ && editor_.toolbox_.tree_) {
                editor_.toolbox_.tree_.setSelectedItem(null);
            }
        } else {
            // Toolbox mode is different, need to refresh.
            this.delayLoadXml = this.getCurrentSource();
            this.editor = undefined;
            this.loadingXml = false;
            if (this.loadingXmlPromise) {
                this.loadingXmlPromise.cancel();
                this.loadingXmlPromise = null;
            }
            this.prepareBlockly(showCategories);
            this.domUpdate();
            this.editor.scrollCenter();
        }
    }
}