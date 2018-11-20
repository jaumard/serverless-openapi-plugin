const SwaggerParser = require('swagger-parser')
const Joi = require("joi")
const joiConvert = require('joi-to-json-schema')
const fs = require("fs")
const ejs = require("ejs")
const mkdirSync = fs.mkdirSync
const HANDLER_KEY = 'x-serverless-handler'
const srcFolder = 'src/'
const validationFolder = srcFolder + 'validations/'
const modelFolder = srcFolder + 'models/'
const handlerFolder = srcFolder + 'handlers/'
const templateFolder = 'templates/'

const createDirs = (dirName) => {
    try {
        mkdirSync(dirName)
    } catch (e) {

    }
}

class OpenApiPlugin {
    constructor(serverless, options) {
        this.serverless = serverless
        this.options = options
        // Serverless service custom variables
        this.customVars = this.serverless.variables.service.custom

        this.commands = {
            openapi: {
                usage: 'Parse and setup your project from an OpenApi definition',
                lifecycleEvents: [
                    'parse',
                ],
                options: {
                    skipValidation: {
                        usage:
                            'If set, skip the validation of API input ',
                        required: false,
                        shortcut: 'sv',
                    },
                },
            },
        }

        this.hooks = {
            'before:openapi:parse': this.beforeParse.bind(this),
            'openapi:parse': this.parse.bind(this),
            'after:openapi:parse': this.afterParse.bind(this),
        }
    }

    beforeParse() {
        this.serverless.cli.log('beforeParse!')

        if (this.customVars.definition) {
            return SwaggerParser.validate(this.customVars.definition).then(definition => this.definition = definition)
        }
        else {
            return Promise.reject('You need to define your API under "custom -> definition"')
        }
    }

    parse() {
        this.serverless.cli.log('parse swagger')
        const skipValidation = this.options.skipValidation
        const skipModels = this.options.skipModels

        createDirs(handlerFolder)

        if (!skipValidation) {
            createDirs(validationFolder)
        }

        if (!skipModels) {
            createDirs(modelFolder)
        }

        const operations = this.definition.paths
        Object.keys(operations).forEach(path => {
            const methods = operations[path]
            let handler = methods[HANDLER_KEY]

            Object.keys(methods).forEach(method => {
                if (method !== HANDLER_KEY) {
                    const methodDefinition = methods[method]
                    let methodController = handler
                    if (methodDefinition[HANDLER_KEY]) {
                        methodController = methodDefinition[HANDLER_KEY]
                    }

                    let finalHandler = methodController;

                    if (!methodController) return;

                    let methodControllerPath = methodController.split('/');
                    let controller = methodControllerPath.pop().split('.')[0];

                    if (methodControllerPath.length === 0) {
                        finalHandler = methodDefinition.operationId
                    }
                    else {
                        finalHandler = methodControllerPath.join('/') + '/' + methodDefinition.operationId
                    }

                    const validationSchema = this._mapValidations(this.definition, methodDefinition)

                    let subPath = finalHandler.split('/')
                    if (subPath.length > 1) {
                        subPath.pop();
                        subPath = subPath.join('/') + '/'
                        createDirs(validationFolder + subPath)
                    }
                    else {
                        subPath = ''
                    }
                    const schemaFile = finalHandler

                    fs.writeFileSync(validationFolder + schemaFile + '.json', JSON.stringify(joiConvert(validationSchema), null /*(key, value) => {
                        if (key === '_currentJoi') {
                            return;
                        }
                        return value;
                    }*/, 2), 'utf8')

                    this.writeHandler(methodDefinition.operationId, method.toLowerCase(), path, srcFolder + subPath + controller.split('_')[0], schemaFile);
                    this.updateServerlessDefinition(srcFolder + subPath + controller.split('_')[0]);
                }
            })
        })

    }

    afterParse() {
        this.serverless.cli.log('afterParse')
        return Promise.resolve()
    }

    _getJoiValidation(description) {
        if (!description) {
            return null
        }
        let type = description.type
        switch (description.format) {
            case 'int32':
            case 'int64':
                type = 'integer'
                break
            case 'float':
            case 'double':
                type = 'double'
                break
            case 'byte':
                type = 'byte'
                break
            case 'binary':
                type = 'binary'
                break
        }

        let joi
        switch (type) {
            case 'object': {
                const props = {}
                Object.keys(description.properties).forEach(key => {
                    const prop = description.properties[key]
                    if (description.required && description.required.length > 0) {
                        prop.required = description.required.find(item => key === item)
                    }
                    props[key] = this._getJoiValidation(prop)
                })
                joi = Joi.object(props)
                break
            }
            case 'array': {
                joi = Joi.array().items(this._getJoiValidation(description.items))
                break
            }
            case 'byte': {
                joi = Joi.base64()
                break
            }
            case 'date':
            case 'dateTime': {
                joi = Joi.date()
                break
            }
            case 'integer':
                joi = Joi.number().integer()
                break
            case 'long':
                joi = Joi.number()
                break
            case 'float':
                joi = Joi.number()
                break
            case 'double':
                joi = Joi.number()
                break
            case 'boolean':
                joi = Joi.boolean()
                break
            default: {
                joi = Joi.string()
            }
        }
        if (description.pattern) {
            joi = joi.regex(description.pattern)
        }
        if (description.length) {
            joi = joi.length(description.length)
        }
        if (description.maxItems || description.maxLength) {
            joi = joi.max(description.maxItems || description.maxLength)
        }
        if (description.minItems || description.minLength) {
            joi = joi.min(description.minItems || description.minLength)
        }
        if (description.enum) {
            joi = joi.valid(...description.enum)
        }
        if (description.maximum) {
            joi = joi.max(description.maximum)
        }
        if (description.minimum) {
            joi = joi.min(description.minimum)
        }
        if (description.required) {
            joi = joi.required()
        }
        return joi
    }

    _mapValidations(definition, methodDefinition) {
        const validation = {}
        const headersValidation = {}
        const queryValidation = {}
        const paramsValidation = {}
        let bodyValidation = {}
        if (methodDefinition['consumes'] && methodDefinition['consumes'].length > 0) {
            headersValidation['content-type'] = Joi.string().valid(...methodDefinition['consumes']).required()
        }
        if (methodDefinition['produces'] && methodDefinition['produces'].length > 0) {
            headersValidation['accept'] = Joi.string().valid(...methodDefinition['produces']).required()
        }

        if (methodDefinition['parameters'] && methodDefinition['parameters'].length > 0) {
            methodDefinition['parameters'].forEach(param => {
                switch (param.in) {
                    case 'query':
                        queryValidation[param.name] = this._getJoiValidation(param)
                        break
                    case 'path':
                        paramsValidation[param.name] = this._getJoiValidation(param)
                        break
                    case 'body': {
                        const description = param.schema
                        if (description.type === 'array') {
                            bodyValidation = this._getJoiValidation(description)
                        }
                        else if (description.type === 'object') {
                            Object.keys(description.properties).forEach(key => {
                                const prop = description.properties[key]
                                if (description.required && description.required.length > 0) {
                                    prop.required = description.required.find(item => key === item)
                                }
                                bodyValidation[key] = this._getJoiValidation(prop)
                            })
                            bodyValidation = Joi.object(bodyValidation)
                        }
                        break
                    }
                    case 'formData':
                        bodyValidation[param.name] = this._getJoiValidation(param)
                        break
                    case 'header':
                        headersValidation[param.name.toLowerCase()] = this._getJoiValidation(param)
                        break
                }
            })
            if (Object.keys(headersValidation).length > 0) {
                validation.headers = Joi.object(headersValidation).unknown(true)
            }
            else {
                validation.headers = Joi.object({}).unknown(true)
            }
            if (Object.keys(paramsValidation).length > 0) {
                validation.params = Joi.object(paramsValidation)
            }
            else {
                validation.params = Joi.object({})
            }
            if (Object.keys(queryValidation).length > 0) {
                validation.query = Joi.object(queryValidation)
            }
            else {
                validation.query = Joi.object({})
            }
            if (Object.keys(bodyValidation).length > 0) {
                validation.body = bodyValidation
            }
            else {
                validation.body = Joi.object({})
            }
        }

        const types = ['headers', 'params', 'query', 'body']
        types.forEach((type) => {
            let rule = validation[type]

            // null, undefined, true - anything allowed
            // false - nothing allowed
            // {...} - ... allowed
            rule = (rule === false ? Joi.object({}).allow(null) :
                typeof rule === 'function' ? rule :
                    !rule || rule === true ? Joi.any() :
                        Joi.compile(rule))
            validation[type] = rule
        })

        return Joi.object(validation)
    }

    writeHandler(operationId, method, httpPath, fileName, schemaFile) {
        const handlerFile = handlerFolder + schemaFile + '.js'
        const definitionFile = fileName + '.yml'

        let subPath = schemaFile.split('/')
        let relativeToRoot = subPath.length
        subPath.pop()
        subPath = subPath.join('/') + '/'
        createDirs(handlerFolder + subPath)
        createDirs(srcFolder + subPath)

        if (fs.existsSync(definitionFile)) {
            const existingContent = fs.readFileSync(definitionFile, "utf8")
            const search = `
${operationId}:
    handler: ${schemaFile.replace('/', '.')}.${operationId}
`
            if (existingContent.indexOf(search) === -1) {
                ejs.renderFile(templateFolder + 'function.tpl', {
                        method: method,
                        name: operationId,
                        path: httpPath,
                        handler: handlerFolder+schemaFile
                    },
                    {}, (err, content) => {
                        if (err) {
                            this.serverless.cli.log(err)
                        }
                        else {
                            fs.writeFileSync(definitionFile, existingContent + content, 'utf8')
                        }
                    })
            } else {
                this.serverless.cli.log(`${definitionFile}::${operationId} already exist, skipping...`)
            }

        } else {
            ejs.renderFile(templateFolder + 'function.tpl', {
                    method: method,
                    name: operationId,
                    path: httpPath,
                    handler: handlerFolder+schemaFile
                },
                {}, (err, content) => {
                    if (err) {
                        this.serverless.cli.log(err)
                    }
                    else {
                        fs.writeFileSync(definitionFile, content, 'utf8')
                    }
                })
        }

        if (fs.existsSync(handlerFile) && false) {
            this.serverless.cli.log(`${handlerFile} already exist, skipping...`)
        } else {
            ejs.renderFile(templateFolder + 'method.tpl', {
                method: method,
                name: operationId,
                validationSchemaFile: '../'.repeat(relativeToRoot) + validationFolder.replace(srcFolder, '') + schemaFile
            }, {}, (err, content) => {
                if (err) {
                    this.serverless.cli.log(err)
                }
                else {
                    fs.writeFileSync(handlerFile, content, 'utf8')
                }
            });

        }

        fileName += '.js'
        const exist = fs.existsSync(fileName)
        let handlerSubPath = schemaFile.split('/')
        let handlerRelativeToRoot = handlerSubPath.length
        if (exist) {
            const existingContent = fs.readFileSync(fileName, "utf8")
            const updatedContent = this._getUpdatedIndexFile(operationId, '../'.repeat(handlerRelativeToRoot) + handlerFile, existingContent)
            fs.writeFileSync(fileName, updatedContent, 'utf8')
        }
        else {
            fs.writeFileSync(fileName, this._getUpdatedIndexFile(operationId, '../'.repeat(handlerRelativeToRoot) + handlerFile, ''), 'utf8')
        }

    }

    _getUpdatedIndexFile(name, path, fileContents) {
        let requireStatement = `exports.${name} = require('${path}')\n`

        if (fileContents.indexOf(requireStatement) === -1) {
            return fileContents + requireStatement;
        }
        return fileContents;
    }

    updateServerlessDefinition(fileName) {
        const existingContent = fs.readFileSync('serverless.yml', "utf8")

        if (existingContent.indexOf(fileName + '.yml') === -1) {
            fs.writeFileSync('serverless.yml', existingContent.replace('functions:\n', 'functions:\n  - ${file(' + fileName + '.yml)}\n'), 'utf8')
        }
    }
}

module.exports = OpenApiPlugin;
