# serverless-openapi-plugin

Serverless plugin to generate AWS serverless architecture from openApi definition.

It also generate validation (using Joi) for headers/query/params and body.

## Configuration
On your `serverless.yml` add:

```
plugins: 
 -serverless-openapi-plugin
``` 

By default the plugin is looking for a `definition.yml`, but you can override this setting using:
```
customs: 
 definition: mydefinition.yml
``` 

In order to generate handlers, you need to specify the handler name at root or operation level with `x-serverless-handler` key.

## Usage
Simple as:
```
serverless openapi
```
