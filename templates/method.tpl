const Joi = require('joi')
const validation = require('<%= validationSchemaFile %>')

module.exports.<%= name %> = async (event, context) => {
    if(event.httpMethod.toLowerCase() !== '<%= method %>') { //TODO manage validation of request not method
       return {
               statusCode: 400,
               body: JSON.stringify({
                 code: 'HTTP_METHOD_NOT_SUPPORTED',
                 message: '<%= method %> not supported',
               }),
             };
    }

    return {
        statusCode: 200,
        body: JSON.stringify({
          message: 'TODO',
        }),
      };
}