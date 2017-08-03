function AbstractInterpreter(code, filename) {
    NodeVisitor.apply(this, Array.prototype.slice.call(arguments));
}
AbstractInterpreter.prototype = new NodeVisitor();

AbstractInterpreter.prototype.processCode = function(code, filename) {
    // Code
    this.source = code !== "" ? code.split("\n") : [];
    filename = filename || '__main__';
    
    // Attempt parsing - might fail!
    try {
        var parse = Sk.parse(filename, code);
        var ast = Sk.astFromParse(parse.cst, filename, parse.flags);
        this.processAst(ast);
    } catch (error) {
        this.report = {"error": error, "message": "Parsing error"};
        return;
    }
};

AbstractInterpreter.prototype.processAst = function(ast) {
    this.ast = ast;
    // Handle loops
    this.loopStackId = 0
    this.loopHierarchy = {};
    this.loopStack = [];
    
    // Handle decisions
    this.branchStackId = 0;
    
    this.branchTree = { null: [] };
    this.currentBranch = this.branchTree[null];
    this.currentBranchName = null;
    
    // Handle walking AST
    this.astStackDepth = 0;
    
    this.variables = {};
    this.variableTypes = {};
    this.variablesNonBuiltin = {};
    for (var name in this.BUILTINS) {
        this.setVariable(name, this.BUILTINS[name]);
    }
    
    // OLD
    //this.frameIndex = 0;
    //this.rootFrame = this.newFrame(null);
    //this.currentFrame = this.rootFrame;
    this.report = this.newReport();
    
    this.visit(this.ast);
    
    //console.log(this.variables)
    this.postProcess();
}

AbstractInterpreter.prototype.newReport = function(parentFrame) {
    return {
            "error": false,
            "Unconnected blocks": [],
            "Unread variables": [],
            "Undefined variables": [],
            "Possibly undefined variables": [],
            "Overwritten variables": [],
            "Append to non-list": [],
            "Used iteration list": [],
            "Unused iteration variable": [],
            "Non-list iterations": [],
            "Empty iterations": [],
            "Type changes": [],
            "Iteration variable is iteration list": [],
            "Unknown functions": [],
            "Incompatible types": []
        }
}

AbstractInterpreter.prototype._initializeVariable = function(name) {
    if (!(name in this.variables)) {
        this.variables[name] = [];
    }
}
AbstractInterpreter.prototype._newBehavior = function(method, type, position, currentType) {
    return {"method": method, 
            "type": type, 
            "loop": this.loopStackId, 
            "parentName": this.currentBranchName,
            "position": position, 
            "currentType": currentType};
}

AbstractInterpreter.prototype.setVariable = function(name, type, position) {
    this._initializeVariable(name);
    this.variables[name].push(this._newBehavior("set", type, position, type));
}
AbstractInterpreter.prototype.setIterVariable = function(name, type, position) {
    this._initializeVariable(name);
    this.variables[name].push(this._newBehavior("set_iterate", type, position, type));
}
AbstractInterpreter.prototype.updateVariable = function(name, type, position) {
    this._initializeVariable(name);
    this.variables[name].push(this._newBehavior("update", type, position, type));
}
AbstractInterpreter.prototype.readVariable = function(name, position) {
    this._initializeVariable(name);
    var previousType = this.getType(name);
    this.variables[name].push(this._newBehavior("read", null, position, previousType));
}
AbstractInterpreter.prototype.iterateVariable = function(name, position) {
    this._initializeVariable(name);
    var previousType = this.getType(name);
    this.variables[name].push(this._newBehavior("iterate", null, position, previousType));
}
// The type here refers to the subtype of the list
AbstractInterpreter.prototype.appendVariable = function(name, type, position) {
    this._initializeVariable(name);
    this.variables[name].push(this._newBehavior("append", type, position, {
        "type": "List", "subtype": type, "empty": false
    }));
}

function nameBranch(branch) {
    return (branch.id == null ? null : branch.id+branch.path[0]);
}

function otherBranch(branch) {
    return (branch.id == null ? null : branch.id+(branch.path[0] == 'i' ? 'e' : 'i'));
}

AbstractInterpreter.prototype.postProcess = function() {
    for (var name in this.variables) {
        if (!(name in this.BUILTINS)) {
            //console.log("STARTING", name, this.source)
            var trace = this.variables[name];
            this.variablesNonBuiltin[name] = trace.slice();
            //console.log(name, this.variablesNonBuiltin[name])
            if (name == "___") {
                this.report["Unconnected blocks"].push({"position": trace[0].position})
            }
            /*console.log(name, trace.map(function(e, i) { 
                return e.method +(e.type == null ? "" : "["+e.type.type+"]")
                                +("_"+e.parentName);
            }));*/
            // Check for unread variables
            var previousBehavior = null;
            
            var traceTree = (function buildTraceTree(nodes, parentId) {
                var result = [];
                while (trace.length && parentId == trace[0].parentName) {
                    result.push(trace.shift())
                }
                
                for (var i = 0, len = nodes.length; i < len; i += 1) {
                    var node = nodes[i];
                    result.push({
                        "if": buildTraceTree(node["if"], node.id+"i"),
                        "else": buildTraceTree(node["else"], node.id+"e"),
                        "method": "branch"
                    })
                    while (trace.length && parentId == trace[0].parentName) {
                        result.push(trace.shift())
                    }
                    
                }
                return result;
            })(this.branchTree[null], null);
            //console.log("TT", this.source, traceTree)
            
            var SETTINGS = ["was set", "was read", "was overwritten"],
                report = this.report,
                previousType = null,
                testTypeEquality = this.testTypeEquality.bind(this),
                overwrittenLine = null,
                variableTypes = this.variableTypes;
            var finalState = (function walkState(nodes, previous) {
                var result;
                if (previous === null) {
                    result = {"was set": "no", "was read": "no", "was overwritten": "no"}
                } else {
                    result = {"was set": previous["was set"],
                              "was read": previous["was read"],
                              "was overwritten": previous["was overwritten"]};
                }
                for (var i = 0, len = nodes.length; i < len; i += 1) {
                    var node = nodes[i];
                    if (node.type !== null && node.type !== undefined && !(name in variableTypes)) {
                        variableTypes[name] = node.type;
                    }
                    if (node.method == "branch") {
                        var ifResult = walkState(node["if"], result)
                        var elseResult = walkState(node["else"], result)
                        for (var j = 0, len2 = SETTINGS.length; j < len2; j += 1) {
                            var setting = SETTINGS[j];
                            if (ifResult[setting] == "yes" && elseResult[setting] == "yes") {
                                result[setting] = "yes";
                            } else if (ifResult[setting] == "no" && elseResult[setting] == "no") {
                                result[setting] = "no";
                            } else {
                                result[setting] = "maybe";
                            }
                        }
                        //console.log(ifResult, elseResult, result)
                    } else {
                        if (node["method"] == "set" || node["method"] == "set_iterate") {
                            if (previousType == null) {
                                previousType = node.type;
                            } else {
                                if (node.type != null && testTypeEquality(previousType, node.type)) {
                                    previousType = node.type;
                                } else {
                                    report['Type changes'].push({"name": name, "position": node.position});
                                }
                            }
                            if (result["was set"] == "yes" && result["was read"] == "no") {
                                result["was overwritten"] = "yes";
                                if (overwrittenLine == null) {
                                    overwrittenLine = node.position;
                                }
                            } else {
                                result["was set"] = "yes"
                                if (node["method"] == "set") {
                                    result["was read"] = "no"
                                } else {
                                    result["was read"] = "yes"
                                }
                            }
                        } else if (node["method"] == "read" || node["method"] == "iterate") {
                            if (result["was set"] == "no") {
                                report['Undefined variables'].push({"name": name, "position": node.position});
                            } else if (result["was set"] == "maybe") {
                                report['Possibly undefined variables'].push({"name": name, "position": node.position});
                            }
                            result["was read"] = "yes"
                        } else if (node["method"] == "update" || node["method"] == "append") {
                            if (node["method"] == "append" && previousType != null && previousType.type != "List") {
                                report["Append to non-list"].push({"name": name, "position": node.position, "type": node.type})
                            }
                            if (result["was set"] == "no") {
                                report['Undefined variables'].push({"name": name, "position": node.position});
                            } else if (result["was set"] == "maybe") {
                                report['Possibly undefined variables'].push({"name": name, "position": node.position});
                            }
                            result["was set"] = "yes"
                        }
                    }
                }
                return result;
            })(traceTree, null);
            
            if (finalState["was read"] == "no") {
                this.report['Unread variables'].push({"name": name});
            }
            if (finalState["was overwritten"] == "yes") {
                report['Overwritten variables'].push({"name": name, "position": overwrittenLine});
            }
            
            //console.log("ELLIE", name, finalState);
        }
    }
    /*
    this.checkUnreadVariables(this.rootFrame)
    this.checkUnusedSingular(this.rootFrame)
    this.checkUsedPlural(this.rootFrame)
    this.checkSingularIsPlural(this.rootFrame)
    */
}


AbstractInterpreter.prototype.testTypeEquality = function(left, right) {
    if (left === null || right === null) {
        return false;
    } else if (left.type === null || right.type === null) {
        return false;
    } else if (left.type === "List" && right.type === "List") {
        if (left.empty || right.empty) {
            return true;
        } else {
            return this.testTypeEquality(left.subtype, right.subtype);
        }
    } else {
        return left.type == right.type;
    }
}

AbstractInterpreter.prototype.getType = function(name) {
    if (name in this.variables) {
        var trace = this.variables[name];
        if (trace != undefined && trace.length > 0) {
            return trace[trace.length-1].currentType;
        }
    }
    return null;
}

AbstractInterpreter.prototype.isTypeEmptyList = function(name) {
    var type = this.getType(name);
    return (type !== null && type.type === "List") && (type.empty);
}
AbstractInterpreter.prototype.isTypeSequence = function(name) {
    var type = this.getType(name);
    return (type !== null && 
            arrayContains(type.type, this.TYPE_INHERITANCE['Sequence']));
}

AbstractInterpreter.prototype.visit = function(node) {
    this.astStackDepth += 1;
    NodeVisitor.prototype.visit.call(this, node);
    this.astStackDepth -= 1;
}

AbstractInterpreter.prototype.typecheck = function(value) {
    switch (value._astname) {
        case "Name":
            return this.getType(value.id.v);
        case "Num": case "Str":
            return {"type": value._astname};
        case "Tuple":
            var components = [];
            for (var i = 0, len = value.elts.length; i < len; i++) {
                components.push(this.typecheck(value.elts[i]))
            }
            return {"type": "Tuple", "subtypes": components};
        case "Dict":
            var literals = true;
            for (var i = 0, len = value.keys.length; i < len; i++) {
                var key_type = this.typecheck(value.keys[i]);
                literals = literals && (key_type.type == "Str");
            }
            if (literals) {
                var components = {};
                for (var i = 0, len = value.keys.length; i < len; i++) {
                    var key_type = this.typecheck(value.keys[i]);
                    var value_type = this.typecheck(value.values[i]);
                    components[value.keys[i].s.v] = {"key": key_type, "value": value_type};
                }
                return {"type": "Dict", "literals": true, "subtypes": components};
            } else {
                var key_type = {"type": "Unknown"}, value_type = {"type": "Unknown"};
                if (value.keys.length > 0) {
                    key_type = this.typecheck(value.keys[0]);
                    value_type = this.typecheck(value.values[0]);
                }
                return {"type": "Dict", "literals": false, "key": key_type, "value": value_type};
            }
        case "List":
            if (value.elts.length == 0) {
                return {"type": "List", "empty": true};
            } else {
                return {"type": "List", "empty": false, "subtype": this.typecheck(value.elts[0])};
            }
        case "Call":
            var funcType = this.walkAttributeChain(value.func);
            return funcType;
        case "BinOp":
            var left = this.typecheck(value.left),
                right = this.typecheck(value.right);
            if (left === null || right === null) {
                return null;
            } else if (left.type != right.type) {
                this.report["Incompatible types"].push({"left": left, "right": right, "operation": value.op.name, "position": this.getLocation(value)});
            } else {
                return left;
            }
        default:
            return null;
    }
}

AbstractInterpreter.prototype.walkAttributeChain = function(attribute) {
    if (attribute._astname == "Attribute") {
        var result = this.walkAttributeChain(attribute.value);
        if (result == null) {
            return null;
        } else if (attribute.attr.v in result) {
            return result[attribute.attr.v];
        } else {
            this.report["Unknown functions"].push({"name": attribute.attr.v, "position": this.getLocation(attribute)});
            return null;
        }
    } else if (attribute._astname == "Name") {
        if (attribute.id.v in AbstractInterpreter.MODULES) {
            return AbstractInterpreter.MODULES[attribute.id.v];
        } else if (attribute.id.v in this.BUILTINS) {
            return this.BUILTINS[attribute.id.v].returns;
        } else {
            this.report["Unknown functions"].push({"name": attribute.attr, "position": this.getLocation(attribute)});
            return null;
        }
    }
}

AbstractInterpreter.prototype.getLocation = function(node) {
    return {"column": node.col_offset, "line": node.lineno};
}

AbstractInterpreter.prototype.visit_AugAssign = function(node) {
    var typeValue = this.typecheck(node.value);
    this.visit(node.value);
    this.visit(node.target);
    var walked = this.walk(node.target);
    for (var i = 0, len = walked.length; i < len; i++) {
        var targetChild = walked[i];
        if (targetChild._astname == "Tuple") {
            // TODO: Check if is an iterable (list, tuple, dict, set) literal or variable
        } else if (targetChild._astname == "Name") {
            this.updateVariable(targetChild.id.v, typeValue, this.getLocation(node));
        }
    }
}

AbstractInterpreter.prototype.visit_Call = function(node) {
    if (node.func._astname == "Attribute") {
        if (node.func.attr.v == "append") {
            if (node.args.length >= 1) {
                var valueType = this.typecheck(node.args[0]);
                if (node.func.value._astname == "Name") {
                    var target = node.func.value.id.v;
                    this.appendVariable(target, valueType, this.getLocation(node));
                    this.visitList(node.keywords);
                    this.visitList(node.args);
                    if (node.kwargs != null) {
                        this.visit(node.kwargs);
                    }
                    if (node.starargs != null) {
                        this.visit(node.starargs);
                    }
                } else {
                    this.generic_visit(node);
                }
            } else {
                this.generic_visit(node);
            }
        } else {
            this.generic_visit(node);
        }
    } else {
        //console.log(node);
        this.generic_visit(node);
    }
}
AbstractInterpreter.prototype.visit_Assign = function(node) {
    var typeValue = this.typecheck(node.value);
    this.visit(node.value);
    this.visitList(node.targets);
    for (var i = 0, len = node.targets.length; i < len; i++) {
        var walked = this.walk(node.targets[i]);
        for (var j = 0, len = walked.length; j < len; j++) {
            var targetChild = walked[j];
            if (targetChild._astname == "Tuple") {
                // TODO: Check if is an iterable (list, tuple, dict, set) literal or variable
            } else if (targetChild._astname == "Name") {
                this.setVariable(targetChild.id.v, typeValue, this.getLocation(node));
            }
        }
    }
}
AbstractInterpreter.prototype.visit_Import = function(node) {
    for (var i = 0, len = node.names.length; i < len; i++) {
        var module = node.names[i];
        var asname = module.asname === null ? module.name : module.asname;
        this.setVariable(asname.v, {"type": "Module"}, this.getLocation(node))
    }
}
AbstractInterpreter.prototype.visit_ImportFrom = function(node) {
    for (var i = 0, len = node.names.length; i < len; i++) {
        var module = node.module === null ? node.names[i] : node.module + node.names[i];
        var asname = module.asname === null ? module.name : module.asname;
        this.setVariable(asname.v, {"type": "Module"}, this.getLocation(node));
    }
}

AbstractInterpreter.prototype.visit_Name = function(node) {
    //console.log(node);
    //TODO:
    if (node.ctx.prototype._astname === "Load") {
        this.readVariable(node.id.v, this.getLocation(node));
    }
    this.generic_visit(node);
}

AbstractInterpreter.prototype.visit_FunctionDef = function(node) {
    this.setVariable(node.name.v, {"type": "Function"}, this.getLocation(node))
    var args = node.args.args;
    for (var i = 0; i < args.length; i++) {
        var arg = args[i];
        var name = Sk.ffi.remapToJs(arg.id);
        this.setVariable(name, {}, this.getLocation(node))
    }
    this.generic_visit(node);
}

AbstractInterpreter.prototype.visit_ClassDef = function(node) {
    this.setVariable(node.name.v, {"type": "Class"}, this.getLocation(node))
    this.generic_visit(node);
}

AbstractInterpreter.prototype.visit_If = function(node) {
    // Visit the conditional
    this.visit(node.test);
    
    // Update branch management
    this.branchStackId += 1;
    var branchId = this.branchStackId;
    
    var cb = this.currentBranch,
        cbName = this.currentBranchName,
        branches = {"if": [], 
                    "else": [], 
                    "id": branchId, 
                    "method": "branch",
                    "parentName": this.currentBranchName};
    cb.push(branches)
    
    // Visit the bodies
    this.currentBranch = branches["if"];
    this.currentBranchName = branchId + 'i';
    for (var i = 0, len = node.body.length; i < len; i++) {
        this.visit(node.body[i]);
    }
    this.currentBranch = branches["else"];
    this.currentBranchName = branchId + 'e';
    for (var i = 0, len = node.orelse.length; i < len; i++) {
        this.visit(node.orelse[i]);
    }
    this.currentBranch = cb;
    this.currentBranchName = cbName;
}

AbstractInterpreter.prototype.unpackSequence = function(type) {
    if (type.type == "List" && !type.empty) {
        return type.subtype;
    } else if (type.type == "Str") {
        return {"type": "Str"};
    }
}

AbstractInterpreter.prototype.visit_For = function(node) {
    this.loopStackId += 1;
    // Handle the iteration list
    var walked = this.walk(node.iter),
        iterationList = null;
    for (var i = 0, len = walked.length; i < len; i++) {
        var child = walked[i];
        if (child._astname === "Name" && child.ctx.prototype._astname === "Load") {
            iterationList = child.id.v;
            if (this.isTypeEmptyList(child.id.v)) {
                this.report["Empty iterations"].push({"name": child.id.v, "position": this.getLocation(node)});
            }
            if (!(this.isTypeSequence(child.id.v))) {
                this.report["Non-list iterations"].push({"name": child.id.v, "position": this.getLocation(node)});
            }
            this.iterateVariable(child.id.v, this.getLocation(node));
        } else if (child._astname === "List" && child.elts.length === 0) {
            this.report["Empty iterations"].push({"name": child.id.v, "position": this.getLocation(node)});
        } else {
            this.visit(child);
        }
    }
    var iterType = this.typecheck(node.iter),
        iterSubtype = null;
    if (iterType !== null) {
        iterSubtype = this.unpackSequence(iterType);
    }
    
    // Handle the iteration variable
    walked = this.walk(node.target);
    var iterationVariable = null;
    for (var i = 0, len = walked.length; i < len; i++) {
        var child = walked[i];
        if (child._astname === "Name" && child.ctx.prototype._astname === "Store") {
            iterationVariable = node.target.id.v;
            this.setIterVariable(node.target.id.v, iterSubtype, this.getLocation(node));
        } else {
            this.visit(child);
        }
    }
    
    if (iterationVariable && iterationList && iterationList == iterationVariable) {
        this.report["Iteration variable is iteration list"].push({"name": iterationList, "position": this.getLocation(node)});
    }

    // Handle the bodies
    for (var i = 0, len = node.body.length; i < len; i++) {
        this.visit(node.body[i]);
    }
    for (var i = 0, len = node.orelse.length; i < len; i++) {
        this.visit(node.orelse[i]);
    }
}




var filename = '__main__.py';
//var python_source = 'sum([1,2])/len([4,5,])\ntotal=0\ntotal=total+1\nimport weather\nimport matplotlib.pyplot as plt\ncelsius_temperatures = []\nexisting=weather.get_forecasts("Miami, FL")\nfor t in existing:\n    celsius = (t - 32) / 2\n    celsius_temperatures.append(celsius)\nplt.plot(celsius_temperatures)\nplt.title("Temperatures in Miami")\nplt.show()';
var python_source = ''+
    'b=0\n'+
    'if X:\n'+
        '\ta=0\n'+
        '\tc=0\n'+
    'else:\n'+
        '\tif Y:\n'+
            '\t\ta=0\n'+
            '\t\ta=0\n'+
            '\t\tb = 0\n'+
        '\telif Z:\n'+
            '\t\ta=0\n'+
        '\telse:\n'+
            '\t\ta=0\n'+
        '\tif A:\n'+
            '\t\tb=0\n'+
        '\telse:\n'+
            '\t\ta=0\n'+
    'print(c)';
var analyzer = new AbstractInterpreter(python_source);
//console.log(python_source);
/*
console.log(python_source);
console.log("AST:", analyzer.ast);
console.log("Report:",analyzer.report);
*/