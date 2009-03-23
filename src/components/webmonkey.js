const CLASSNAME = "WebmonkeyService";
const CONTRACTID = "@webmonkey.info/webmonkey-service;1";
const CID = Components.ID("{8d26f120-10b8-11de-8c30-0800200c9a66}");

const Cc = Components.classes;
const Ci = Components.interfaces;

const appSvc = Cc["@mozilla.org/appshell/appShellService;1"]
                 .getService(Ci.nsIAppShellService);

const gmSvcFilename = Components.stack.filename;

function alert(msg) {
  Cc["@mozilla.org/embedcomp/prompt-service;1"]
    .getService(Ci.nsIPromptService)
    .alert(null, "Webmonkey alert", msg);
}

// Examines the stack to determine if an API should be callable.
function GM_apiLeakCheck(apiName) {
  var stack = Components.stack;

  do {
    // Valid stack frames for GM api calls are: native and js when coming from
    // chrome:// URLs and the greasemonkey.js component's file:// URL.
    if (2 == stack.language) {
      // NOTE: In FF 2.0.0.0, I saw that stack.filename can be null for JS/XPCOM
      // services. This didn't happen in FF 2.0.0.11; I'm not sure when it
      // changed.
      if (stack.filename != null &&
          stack.filename != gmSvcFilename &&
          stack.filename.substr(0, 6) != "chrome") {
        GM_logError(new Error("Webmonkey access violation: unsafeWindow " +
                    "cannot call " + apiName + "."));
        return false;
      }
    }

    stack = stack.caller;
  } while (stack);

  return true;
}

/**
 * FireBug 1.2+ console support
 */
function getFirebugConsole(safeWin, unsafeWin, chromeWin) {
  try {
    chromeWin = chromeWin.top;
    // assert FB is installed
    if (!chromeWin.Firebug)
      return null;
    var fbVersion = parseFloat(chromeWin.Firebug.version);
    var fbConsole = chromeWin.Firebug.Console;
    var fbContext = chromeWin.TabWatcher &&
                    chromeWin.TabWatcher.getContextByWindow(unsafeWin);
    // assert FB is enabled
    if (!fbConsole.isEnabled(fbContext))
      return null;

    if (fbVersion == 1.2) {
      // search console handler
      if (fbContext.consoleHandler)
        for (var i = 0; i < fbContext.consoleHandler.length; i++)
          if (fbContext.consoleHandler[i].window == safeWin)
            return fbContext.consoleHandler[i].handler;
      var dummyElm = safeWin.document.createElement("div");
      dummyElm.setAttribute("id", "_firebugConsole");
      safeWin.document.documentElement.appendChild(dummyElm);
      chromeWin.Firebug.Console.injector.addConsoleListener(fbContext, safeWin);
      dummyElm.parentNode.removeChild(dummyElm);
      return fbContext.consoleHandler.pop().handler;
    }

    if (fbVersion == 1.3 || fbVersion == 1.4) {
      fbConsole.injector.attachIfNeeded(fbContext, unsafeWin);
      // find active context
      for (var i=0; i<fbContext.activeConsoleHandlers.length; i++)
        if (fbContext.activeConsoleHandlers[i].window == unsafeWin)
          return fbContext.activeConsoleHandlers[i];
      return null;
    }
  } catch (e) {
    dump('Webmonkey getFirebugConsole() error:\n'+uneval(e)+'\n');
  }
  return null;
}

function prepareSrc(src, unwrap) {
  // unfold legacy API
  var pre = "for (var i in GM) eval('var GM_'+i+' = GM[i]');";
  if (unwrap)
    return pre+src;
  // wrap script into an anonymous function
  return "(function(){"+pre+src+"})()";
}

var webmonkeyService = {
  _config: null,
  get config() {
    if (!this._config)
      this._config = new Config();
    return this._config;
  },
  browserWindows: [],
  updater: null,


  // nsISupports
  QueryInterface: function(aIID) {
    if (!aIID.equals(Ci.nsIObserver) &&
        !aIID.equals(Ci.nsISupports) &&
        !aIID.equals(Ci.nsISupportsWeakReference) &&
        !aIID.equals(Ci.gmIGreasemonkeyService) &&
        !aIID.equals(Ci.nsIWindowMediatorListener) &&
        !aIID.equals(Ci.nsIContentPolicy)) {
      throw Components.results.NS_ERROR_NO_INTERFACE;
    }

    return this;
  },


  // nsIObserver
  observe: function(aSubject, aTopic, aData) {
    if (aTopic == "app-startup") {
      this.startup();
    }
  },


  // gmIGreasemonkeyService
  registerBrowser: function(browserWin) {
    var existing;

    for (var i = 0; existing = this.browserWindows[i]; i++) {
      if (existing == browserWin) {
        // NOTE: Unlocalised strings
        throw new Error("Browser window has already been registered.");
      }
    }

    this.browserWindows.push(browserWin);
  },

  unregisterBrowser: function(browserWin) {
   var existing;

    for (var i = 0; existing = this.browserWindows[i]; i++) {
      if (existing == browserWin) {
        this.browserWindows.splice(i, 1);
        return;
      }
    }

    throw new Error("Browser window is not registered.");
  },

  domContentLoaded: function(wrappedContentWin, chromeWin) {
    var unsafeWin = wrappedContentWin.wrappedJSObject;
    var unsafeLoc = new XPCNativeWrapper(unsafeWin, "location").location;
    var href = new XPCNativeWrapper(unsafeLoc, "href").href;
    var scripts = this.initScripts(href);

    if (scripts.length > 0) {
      this.injectScripts(scripts, href, unsafeWin, chromeWin);
    }

    // Need to wait until well after startup for prefs store and extension
    // manager to be initialized. First page load is a convenient place.
    if (!this.updater) {
      // Note: the param to this has to match the extension ID in install.rdf
      this.updater = new ExtensionUpdater(
          "webmonkey@webmonkey.info");
      this.updater.updatePeriodically();
    }
  },


  startup: function() {
    var loader = Cc["@mozilla.org/moz/jssubscript-loader;1"]
      .getService(Ci.mozIJSSubScriptLoader);
    loader.loadSubScript("chrome://global/content/XPCNativeWrapper.js");
    loader.loadSubScript("chrome://webmonkey/content/prefmanager.js");
    loader.loadSubScript("chrome://webmonkey/content/utils.js");
    loader.loadSubScript("chrome://webmonkey/content/config.js");
    loader.loadSubScript("chrome://webmonkey/content/convert2RegExp.js");
    loader.loadSubScript("chrome://webmonkey/content/miscapis.js");
    loader.loadSubScript("chrome://webmonkey/content/xmlhttprequester.js");
    loader.loadSubScript("chrome://webmonkey/content/updater.js");
    //loggify(this, "GM_GreasemonkeyService");
  },

  shouldLoad: function(ct, cl, org, ctx, mt, ext) {
    var ret = Ci.nsIContentPolicy.ACCEPT;

    // block content detection of webmonkey by denying GM
    // chrome content, unless loaded from chrome
    if (org && org.scheme != "chrome" && cl.scheme == "chrome" &&
        cl.host == "webmonkey") {
      return Ci.nsIContentPolicy.REJECT_SERVER;
    }

    // don't intercept anything when GM is not enabled
    if (!GM_getEnabled()) {
      return ret;
    }

    // don't interrupt the view-source: scheme
    // (triggered if the link in the error console is clicked)
    if ("view-source" == cl.scheme) {
      return ret;
    }

    if (ct == Ci.nsIContentPolicy.TYPE_DOCUMENT &&
        cl.spec.match(/\.user\.js$/)) {

      dump("shouldload: " + cl.spec + "\n");
      dump("ignorescript: " + this.ignoreNextScript_ + "\n");

      if (!this.ignoreNextScript_) {
        if (!this.isTempScript(cl)) {
          var winWat = Cc["@mozilla.org/embedcomp/window-watcher;1"]
            .getService(Ci.nsIWindowWatcher);

          if (winWat.activeWindow && winWat.activeWindow.GM_BrowserUI) {
            winWat.activeWindow.GM_BrowserUI.startInstallScript(cl);
            ret = Ci.nsIContentPolicy.REJECT_REQUEST;
          }
        }
      }
    }

    this.ignoreNextScript_ = false;
    return ret;
  },

  shouldProcess: function(ct, cl, org, ctx, mt, ext) {
    return Ci.nsIContentPolicy.ACCEPT;
  },

  ignoreNextScript: function() {
    dump("ignoring next script...\n");
    this.ignoreNextScript_ = true;
  },

  isTempScript: function(uri) {
    if (uri.scheme != "file") {
      return false;
    }

    var fph = Components.classes["@mozilla.org/network/protocol;1?name=file"]
    .getService(Ci.nsIFileProtocolHandler);

    var file = fph.getFileFromURLSpec(uri.spec);
    var tmpDir = Components.classes["@mozilla.org/file/directory_service;1"]
    .getService(Components.interfaces.nsIProperties)
    .get("TmpD", Components.interfaces.nsILocalFile);

    return file.parent.equals(tmpDir) && file.leafName != "newscript.user.js";
  },

  initScripts: function(url) {
    function testMatch(script) {
      return script.enabled && script.matchesURL(url);
    }

    return GM_getConfig().getMatchingScripts(testMatch);
  },

  injectScripts: function(scripts, url, unsafeContentWin, chromeWin) {
    var sandbox;
    var script;
    var logger;
    var console;
    var storage;
    var xmlhttpRequester;
    var resources;
    var safeWin = new XPCNativeWrapper(unsafeContentWin);
    var safeDoc = safeWin.document;

    // detect and grab reference to firebug console and context, if it exists
    var fbConsole = getFirebugConsole(safeWin, unsafeContentWin, chromeWin);

    for (var i = 0; script = scripts[i]; i++) {
      sandbox = new Components.utils.Sandbox(safeWin);

      logger = new GM_ScriptLogger(script);

      console = fbConsole ? fbConsole : new GM_console(script);

      storage = new GM_ScriptStorage(script);
      xmlhttpRequester = new GM_xmlhttpRequester(unsafeContentWin,
                                                 appSvc.hiddenDOMWindow);
      resources = new GM_Resources(script);

      sandbox.window = safeWin;
      sandbox.document = sandbox.window.document;
      sandbox.unsafeWindow = unsafeContentWin;
      sandbox.console = console;
      // hack XPathResult since that is so commonly used
      sandbox.XPathResult = Ci.nsIDOMXPathResult;

      // add our own APIs
      var GM = sandbox.GM = {};
      GM.addStyle = function(css) { GM_addStyle(safeDoc, css) };
      GM.log = GM_hitch(logger, "log");
      GM.setValue = GM_hitch(storage, "setValue");
      GM.getValue = GM_hitch(storage, "getValue");
      GM.deleteValue = GM_hitch(storage, "deleteValue");
      GM.listValues = GM_hitch(storage, "listValues");
      GM.getResourceURL = GM_hitch(resources, "getResourceURL");
      GM.getResourceText = GM_hitch(resources, "getResourceText");
      GM.openInTab = GM_hitch(this, "openInTab", unsafeContentWin);
      GM.xmlhttpRequest = GM_hitch(xmlhttpRequester,
                                           "contentStartRequest");
      GM.registerMenuCommand = GM_hitch(this,
                                                "registerMenuCommand",
                                                unsafeContentWin);

      sandbox.__proto__ = safeWin;

      var contents = script.textContent;

      var requires = [];
      var offsets = [];
      var offset = 0;

      script.requires.forEach(function(req){
        var contents = req.textContent;
        var lineCount = contents.split("\n").length;
        requires.push(contents);
        offset += lineCount;
        offsets.push(offset);
      });
      script.offsets = offsets;

      var scriptSrc = "\n" + // error line-number calculations depend on these
                         requires.join("\n") +
                         "\n" +
                         contents +
                         "\n";
      if (this.evalInSandbox(prepareSrc(scriptSrc, script.unwrap),
                             url, sandbox, script)) continue;
      // wrap anyway on early return of unwrapped script
      if (script.unwrap)
        this.evalInSandbox(prepareSrc(scriptSrc, false), url, sandbox, script);
    }
  },

  registerMenuCommand: function(unsafeContentWin, commandName, commandFunc,
                                accelKey, accelModifiers, accessKey) {
    var command = {name: commandName,
                   accelKey: accelKey,
                   accelModifiers: accelModifiers,
                   accessKey: accessKey,
                   doCommand: commandFunc,
                   window: unsafeContentWin };

    for (var i = 0; i < this.browserWindows.length; i++) {
      this.browserWindows[i].registerMenuCommand(command);
    }
  },

  openInTab: function(unsafeContentWin, url) {
    var unsafeTop = new XPCNativeWrapper(unsafeContentWin, "top").top;

    for (var i = 0; i < this.browserWindows.length; i++) {
      this.browserWindows[i].openInTab(unsafeTop, url);
    }
  },

  evalInSandbox: function(code, codebase, sandbox, script) {
    if (!(Components.utils && Components.utils.Sandbox)) {
      var e = new Error("Could not create sandbox.");
      GM_logError(e, 0, e.fileName, e.lineNumber);
      return true;
    }
    try {
      // workaround for https://bugzilla.mozilla.org/show_bug.cgi?id=307984
      var lineFinder = new Error();
      Components.utils.evalInSandbox(code, sandbox);
      return true;
    } catch (e) {
      if (!e) return true;
      if ("return not in function" == e.message) // pre-0.8 GM compat:
        return false; // this script depends on the function enclosure

      // try to find the line of the actual error line
      var line = e.lineNumber;
      if (4294967295 == line) {
        // Line number is reported as maxint in edge cases.  Sometimes
        // the right one is in "location" instead. Look there.
        if (e.location && e.location.lineNumber)
          line = e.location.lineNumber;
        else
          // Reporting maxint is useless, if we couldn't find it in location
          // either, forget it. A value of 0 isn't shown in the console.
          line = 0;
      }

      if (line) {
        var err = this.findError(script, line - lineFinder.lineNumber - 1);
        GM_logError(e, 0, err.uri, err.lineNumber);
      } else {
        GM_logError(e, 0, script.fileURL, 0);
      }
      return true;
    }
  },

  findError: function(script, lineNumber){
    var start = 0;
    var end = 1;

    for (var i = 0; i < script.offsets.length; i++) {
      end = script.offsets[i];
      if (lineNumber < end) {
        return {
          uri: script.requires[i].fileURL,
          lineNumber: (lineNumber - start)
        };
      }
      start = end;
    }

    return {
      uri: script.fileURL,
      lineNumber: (lineNumber - end)
    };
  }

};

webmonkeyService.wrappedJSObject = webmonkeyService;

//loggify(webmonkeyService, "webmonkeyService");



/**
 * XPCOM Registration goop
 */
var Module = new Object();

Module.registerSelf = function(compMgr, fileSpec, location, type) {
  compMgr = compMgr.QueryInterface(Ci.nsIComponentRegistrar);
  compMgr.registerFactoryLocation(CID,
                                  CLASSNAME,
                                  CONTRACTID,
                                  fileSpec,
                                  location,
                                  type);

  var catMgr = Cc["@mozilla.org/categorymanager;1"]
                 .getService(Ci.nsICategoryManager);

  catMgr.addCategoryEntry("app-startup",
                          CLASSNAME,
                          CONTRACTID,
                          true,
                          true);

  catMgr.addCategoryEntry("content-policy",
                          CONTRACTID,
                          CONTRACTID,
                          true,
                          true);
};

Module.getClassObject = function(compMgr, cid, iid) {
  if (!cid.equals(CID)) {
    throw Components.results.NS_ERROR_NOT_IMPLEMENTED;
  }

  if (!iid.equals(Ci.nsIFactory)) {
    throw Components.results.NS_ERROR_NO_INTERFACE;
  }

  return Factory;
};

Module.canUnload = function(compMgr) {
  return true;
};


var Factory = new Object();

Factory.createInstance = function(outer, iid) {
  if (outer != null) {
    throw Components.results.NS_ERROR_NO_AGGREGATION;
  }

  return webmonkeyService;
};


function NSGetModule(compMgr, fileSpec) {
  return Module;
}

//loggify(Module, "webmonkeyService:Module");
//loggify(Factory, "webmonkeyService:Factory");
