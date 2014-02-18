var DependencyGraph = require('dep-graph'),
	ObjectBuilder = require('./builder'),
  EventEmitter2 = require('eventemitter2').EventEmitter2,
  lifetimes = require('./lifetime'),
	async = require('async'),
  coreUtil = require('util'),
	util = require('./util');

function createUnregisteredError(key) {
	return new Error('Nothing with key "' + key + '" is registered in the container');
}

function getKeyFromCtor(ctor) {
	return ctor.name;
}
function getKeyFromInstance(instance) {
	return instance && instance.constructor && instance.constructor.name;
}

function Registration(name, lifetime, injections) {
	this.name = name;
	this.lifetime = lifetime || new lifetimes.Transient();
	this.injections = injections || [];
}

function TypeRegistration(name, lifetime, injections, typeInfo) {
	Registration.call(this, name, lifetime, injections);
	this.typeInfo = typeInfo;
}

function InstanceRegistration(name, lifetime, injections, instance) {
	Registration.call(this, name, lifetime, injections);
	this.instance = instance;
}

function FactoryRegistration(name, lifetime, injections, factory) {
	Registration.call(this, name, lifetime, injections);
	this.factory = factory;
}

function Container(parent) {
	this.parent = parent || null;
	this.registrations = {};
	this.handlerConfigs = [];
	this.graph = new DependencyGraph();
	this.builder = new ObjectBuilder(
		this.resolve.bind(this),
		this.resolveSync.bind(this)
	);

  EventEmitter2.call(this, { delimiter: '::', wildcard: true });
}

function resolveSignatureToOptions(args) {
	args = [].slice.call(args, 1);

	if (args.length === 0) {
		return {};
	}

	//just a regular options object (making sure to check for null!)
	if (args[0] && typeof(args[0]) === 'object') {
		return args[0];
	}

	var options = {};
	if (typeof(args[0]) === 'string') {
		options.key = args[0];
	}
	if (args[1]) {
		options.lifetime = args[1];
	}

	options.injections = args.slice(2);

	return options;
}

coreUtil.inherits(Container, EventEmitter2);

/**
 * Registers a type from a constructor
 *
 * @param {Function} ctor The constructor of the type to register
 * @param {String} [key] The resolution key
 * @param {Object} [lifetime] The lifetime manager of this object, defaults
 * to sahara.Lifetime.Transient
 * @param {Object...} [injections] Injections to perform upon resolution
 * @return {Container}
 */
Container.prototype.registerType = function(ctor, key, lifetime, injections) {
  var options = resolveSignatureToOptions(arguments);
  var typeInfo = util.getTypeInfo(ctor, options.key),
    typeName = typeInfo.name;

  this.registrations[typeName] = new TypeRegistration(
    typeName,
    options.lifetime,
    options.injections,
    typeInfo
  );

  //add to the dependency graph to verify that there are no
  //circular dependencies (the graph isn't used anywhere else)
  for (var i = 0; i < typeInfo.args.length; i++) {
    this.graph.add(typeName, typeInfo.args[i].type);
  }

  //the graph isn't actually built until you try to get the chain
  this.graph.getChain(typeName);

  return this;
};

/**
 * Registers a specific instance of a type
 *
 * @param {Object} instance The instance to store
 * @param {String} [key] The resolution key
 * @param {Object} [lifetime] The lifetime manager of this object, defaults
 * to sahara.Lifetime.Transient
 * @param {Object...} [injections] Injections to perform upon resolution
 * @return {Container}
 */
Container.prototype.registerInstance = function(instance, key, lifetime, injections) {
  var options = resolveSignatureToOptions(arguments);
  options.key = options.key || getKeyFromInstance(instance);
  this.registrations[options.key] = new InstanceRegistration(
    options.key,
    options.lifetime,
    options.injections,
    instance
  );

  return this;
};

/**
 * Registers a factory function for a type that will create
 * the object
 *
 * @param {Function} factory A function that creates the object; this function
 * should take one parameter, the container
 * @param {String} [key] The resolution key
 * @param {Object} [lifetime] The lifetime manager of this object, defaults
 * to sahara.Lifetime.Transient
 * @param {Object...} [injections] Injections to perform upon resolution
 * @return {Container}
 */
Container.prototype.registerFactory = function(factory, key, lifetime, injections) {
  var options = resolveSignatureToOptions(arguments);
  if (!options.key) {
    throw new Error('"options.key" must be passed to registerFactory()');
  }

  this.registrations[options.key] = new FactoryRegistration(
    options.key,
    options.lifetime,
    options.injections,
    factory
  );
  return this;
};

/**
 * Determines if something is registered with the given key
 * @param {String|Function} key The resolution key or constructor
 * @return {Boolean}
 */
Container.prototype.isRegistered = function(key) {
  if (typeof(key) === 'function') {
    key = getKeyFromCtor(key);
  }

  return !!this.registrations[key];
};

/**
 * Resolves a type to an instance
 *
 * @param {String|Function} key The resolution key or constructor to resolve
 * @param {Function} callback
 */
Container.prototype.resolve = function(key, callback) {
  var start = new Date().getTime();
  if (typeof(key) === 'function') {
    key = getKeyFromCtor(key);
  }

  var registration = this.registrations[key];
  if (!registration) {
    callback(createUnregisteredError(key));
    return;
  }

  var existing = registration.lifetime.fetch();
  if (existing) {
    this.emit('log::resolve', 'Found an existing instance', {
      time: new Date().getTime - start,
      type: key
    });
    callback(null, existing);
    return;
  }

  var self = this;
  function injectAndReturn(err, instance) {
    if (err) {
      callback(err);
      return;
    }

    self.inject(instance, key, function(err) {
      if (!err) {
        registration.lifetime.store(instance);
      }

      self.emit('log::resolve', 'Injected an instance', {
        time: new Date().getTime - start,
        type: key
      });
      callback(err, instance);
    });
  }

  if (registration instanceof InstanceRegistration) {
    injectAndReturn(null, registration.instance);
  } else if (registration instanceof TypeRegistration) {
    this.builder.newInstance(registration.typeInfo, this.handlerConfigs, injectAndReturn);
  } else if (registration instanceof FactoryRegistration) {
    registration.factory(this, injectAndReturn);
  }
};

/**
 * Resolve a type to an instance synchronously
 *
 * @param {String|Function} key The resolution key or constructor to resolve
 * @return {*} The resolved object
 */
Container.prototype.resolveSync = function(key) {
  var start = new Date().getTime();
  if (typeof(key) === 'function') {
    key = getKeyFromCtor(key);
  }

  var registration = this.registrations[key];
  if (!registration) {
    throw createUnregisteredError(key);
  }

  var existing = registration.lifetime.fetch();
  if (existing) {
    this.emit('log::resolve', 'Found an existing instance', {
      time: new Date().getTime - start,
      type: key
    });
    return existing;
  }

  var instance;
  if (registration instanceof InstanceRegistration) {
    instance = registration.instance;
  } else if (registration instanceof TypeRegistration) {
    instance = this.builder.newInstanceSync(registration.typeInfo, this.handlerConfigs);
  } else if (registration instanceof FactoryRegistration) {
    instance = registration.factory(this);
  }

  this.injectSync(instance, key);
  registration.lifetime.store(instance);
  this.emit('log::resolve', 'Injected an instance (sync)', {
    time: new Date().getTime - start,
    type: key
  });
  return instance;
};

/**
 * Same as resolveSync(), but won't ever throw
 * @param key
 * @return {*} The resolved object, or undefined if the key doesn't exist
 */
Container.prototype.tryResolveSync = function(key) {
  try {
    return this.resolveSync(key);
  } catch (e) {
    return undefined;
  }
};

/**
 * Performs injection on an object
 *
 * @param {*} instance The object to perform injection on
 * @param {String} key The resolution key; defaults to instance.constructor.name
 * @param {Function} callback
 */
Container.prototype.inject = function(instance, key, callback) {
  key = key || getKeyFromInstance(instance);
  var registration = this.registrations[key];
  if (!registration) {
    callback(createUnregisteredError(key));
    return;
  }

  var self = this;
  async.each(registration.injections, function(injection, next) {
    injection.inject(instance, self, function(err) {
      process.nextTick(function() {
        next(err);
      });
    });
  }, callback);
};

/**
 * Performs injection on an object synchronously
 *
 * @param {*} instance The object to perform injection on
 * @param {String} [key] The resolution key; defaults to instance.constructor.name
 */
Container.prototype.injectSync = function(instance, key) {
  key = key || getKeyFromInstance(instance);
  var registration = this.registrations[key];
  if (!registration) {
    throw createUnregisteredError(key);
  }

  var self = this;
  registration.injections.forEach(function(injection) {
    injection.injectSync(instance, self);
  });
};

/**
 * Configures interception
 *
 * @param {Function|Boolean|String|Array} matcher A predicate to determine if the
 * function should be intercepted
 * @param {Function...} callHandler
 * @return {Object} { sync: function() {}, async: function() {} }
 */
Container.prototype.intercept = function(matcher, callHandler) {
  var predicate = matcher;
  if (typeof(matcher) === 'string') {
    predicate = function(instance, methodName) {
      return methodName === matcher;
    };
  } else if (Array.isArray(matcher)) {
    predicate = function(instance, methodName) {
      return instance instanceof matcher[0] && (!matcher[1] || matcher[1] === methodName);
    };
  } else if (typeof(matcher) !== 'function') {
    matcher = !!matcher;
    predicate = function() {
      return matcher;
    };
  }

  var handlers = [].slice.call(arguments, 1),
    handlerConfig = {
      handlers: handlers,
      matcher: predicate
    };

  var container = this;
  return {
    sync: function() {
      handlerConfig.isAsync = false;
      container.handlerConfigs.push(handlerConfig);
      return container;
    },
    async: function() {
      handlerConfig.isAsync = true;
      container.handlerConfigs.push(handlerConfig);
      return container;
    }
  };
};

/**
 * Creates a clone of the container in its current state
 *
 * @returns {Container}
 */
Container.prototype.createChildContainer = function() {
  var childContainer = new Container(this),
    self = this;

  Object.keys(this.registrations).forEach(function(key) {
    childContainer.registrations[key] = self.registrations[key];
  });

  Object.keys(this.graph.map).forEach(function(key) {
    childContainer.graph.map[key] = self.graph.map[key];
  });

  this.handlerConfigs.forEach(function(config) {
    childContainer.handlerConfigs.push(config);
  });

  return childContainer;
};


module.exports = Container;