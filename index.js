const SwaggerParser = require('swagger-parser')
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

        if (!this.customVars.definition) {
            this.customVars.definition = 'definition.yml'
        }

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

        const defaultHandler = this.definition[HANDLER_KEY]

        Object.keys(operations).forEach(path => {
            const methods = operations[path]
            let handler = methods[HANDLER_KEY]

            const commonParameters = methods['parameters']

            Object.keys(methods).forEach(method => {
                if (method !== HANDLER_KEY && method !== 'parameters') {
                    const methodDefinition = methods[method]
                    let methodController = handler || defaultHandler
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

                    if (methodDefinition.parameters) {
                        methodDefinition.parameters = methodDefinition.parameters.concat(commonParameters)
                    }
                    else {
                        methodDefinition.parameters = commonParameters
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

                    fs.writeFileSync(validationFolder + schemaFile + '.js', validationSchema, 'utf8')

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
            return ''
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
                joi = 'Joi.object({'
                Object.keys(description.properties).forEach(key => {
                    const prop = description.properties[key]
                    if (description.required && Array.isArray(description)) {
                        prop.required = description.required.find(item => key === item)
                    } else if (description.required && description.required === key) {
                        prop.required = true;
                    }
                    joi += `${key}: ${this._getJoiValidation(prop)},`
                })
                joi += '})'
                break
            }
            case 'array': {
                joi = `Joi.array().items(${this._getJoiValidation(description.items)})`
                break
            }
            case 'byte': {
                joi = 'Joi.base64()'
                break
            }
            case 'date':
            case 'dateTime': {
                joi = 'Joi.date()'
                break
            }
            case 'integer':
                joi = 'Joi.number().integer()'
                break
            case 'long':
                joi = 'Joi.number()'
                break
            case 'float':
                joi = 'Joi.number()'
                break
            case 'double':
                joi = 'Joi.number()'
                break
            case 'boolean':
                joi = 'Joi.boolean()'
                break
            default: {
                joi = 'Joi.string()'
            }
        }
        if (description.pattern) {
            joi += `.regex(${description.pattern})`
        }
        if (description.length) {
            joi += `.length(${description.length})`
        }
        if (description.maxItems || description.maxLength) {
            joi += `.max(${description.maxItems || description.maxLength})`
        }
        if (description.minItems || description.minLength) {
            joi += `.min(${description.minItems || description.minLength})`
        }
        if (description.enum) {
            joi += `.valid(`
            description.enum.forEach(item => joi += `'${item}',`);
            joi += `)`
        }
        if (description.maximum) {
            joi += `.max(${description.maximum})`
        }
        if (description.minimum) {
            joi += `.min(${description.minimum})`
        }
        if (description.required) {
            joi += `.required()`
        }
        return joi
    }

    _mapValidations(definition, methodDefinition) {
        let headersValidation = ''
        let queryValidation = ''
        let paramsValidation = ''
        let bodyValidation = ''

        if (methodDefinition['consumes'] && methodDefinition['consumes'].length > 0) {
            if (headersValidation === '') {
                headersValidation = 'Joi.object({';
            }
            headersValidation += `'content-type': Joi.string().valid(`;
            methodDefinition['consumes'].forEach(item => headersValidation += `'${item}',`);
            headersValidation += `).required()`;
        }

        if (methodDefinition['produces'] && methodDefinition['produces'].length > 0) {
            if (headersValidation === '') {
                headersValidation = 'Joi.object({';
            }
            headersValidation += `accept: Joi.string().valid(`;
            methodDefinition['produces'].forEach(item => headersValidation += `'${item}',`);
            headersValidation += `).required()`;
        }

        if (methodDefinition['parameters'] && methodDefinition['parameters'].length > 0) {
            methodDefinition['parameters'].forEach(param => {
                switch (param.in) {
                    case 'query':
                        if (queryValidation === '') {
                            queryValidation = 'Joi.object({';
                        }
                        queryValidation += `${param.name}: ${this._getJoiValidation(param)},`;
                        break
                    case 'path':
                        if (paramsValidation === '') {
                            paramsValidation = 'Joi.object({';
                        }
                        paramsValidation += `${param.name}: ${this._getJoiValidation(param)},`;
                        break
                    case 'body': {
                        const description = param.schema
                        if (description.type === 'array') {
                            bodyValidation = `Joi.array(${this._getJoiValidation(description)}),`
                        }
                        else if (description.type === 'object') {
                            bodyValidation = 'Joi.object({'
                            Object.keys(description.properties).forEach(key => {
                                const prop = description.properties[key]
                                if (description.required && description.required.length > 0) {
                                    prop.required = description.required.find(item => key === item)
                                }

                                bodyValidation += `${key}: ${this._getJoiValidation(prop)},`
                            })
                        }
                        break
                    }
                    case 'formData':
                        if (bodyValidation === '') {
                            bodyValidation = 'Joi.object({';
                        }
                        bodyValidation += `${param.name}: ${this._getJoiValidation(param)},`;
                        break
                    case 'header':
                        if (headersValidation === '') {
                            headersValidation = 'Joi.object({';
                        }
                        headersValidation += `${param.name.toLowerCase()}: ${this._getJoiValidation(param)},`;
                        break
                }
            })
        }

        if (headersValidation === '') {
            headersValidation = 'Joi.object({}).unknown(true).required()'
        } else {
            headersValidation += '}).required()'
        }

        if (paramsValidation === '') {
            paramsValidation = 'Joi.object({}).required()'
        } else {
            paramsValidation += '}).required()'
        }

        if (queryValidation === '') {
            queryValidation = 'Joi.object({}).required()'
        } else {
            queryValidation += '}).required()'
        }

        if (bodyValidation === '') {
            bodyValidation = 'Joi.object({}).required()'
        } else {
            bodyValidation += '}).required()'
        }

        return `
const Joi = require('joi')
module.exports = Joi.object({
    params: ${paramsValidation},
    headers: ${headersValidation},
    body: ${bodyValidation},
    query: ${queryValidation},
})`
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
    handler: ${handlerFolder}${schemaFile}.${operationId}`
            if (existingContent.indexOf(search) === -1) {
                ejs.renderFile(templateFolder + 'function.ejs', {
                        method: method,
                        name: operationId,
                        path: httpPath,
                        handler: handlerFolder + schemaFile
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
            ejs.renderFile(templateFolder + 'function.ejs', {
                    method: method,
                    name: operationId,
                    path: httpPath,
                    handler: handlerFolder + schemaFile
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
            ejs.renderFile(templateFolder + 'method.ejs', {
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
