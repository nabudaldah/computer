var uuid    = require('node-uuid');
var spawn   = require('child_process').spawn;
var assert  = require('assert');
var async   = require('async');
var fs      = require('fs');

var R = function(bin, parallel) {
  assert(fs.existsSync(bin), 'R executable should exist.');
  if(typeof(parallel) != "number" || parallel < 1) parallel = require('os').cpus().length;

  this.bin       = bin;
  this.parallel  = parallel;
  this.queue     = [];
  this.instances = [];
  this.influx    = 0;
  this.efflux    = 0;

  this.start = function(callback){

    assert(typeof(callback) == 'function', 'Callback should be a function(err, data)');

    for(var i = 0; i < this.parallel; i++){
      this.instances[i] = {
        bin:     this.bin,
        id:      null,
        process: null,
        job:     null,
        ready:   false
      };
    };

    // For use with next()
    var me = this;

    async.each(this.instances, function(instance, callbackAsync){

      instance.process = spawn(instance.bin, ['--vanilla', '--slave'], { cwd: __dirname });

      instance.id = uuid.v4(); 

      instance.process.stdin.write('cat("ready:'+ instance.id +'");' + '\n');

      // Exception:
      instance.process.on('exit', function (code) {
        if(code) console.error('Warning: R process died (' + code + ')');
      });

      // After stop()
      instance.process.on('close', function (code, signal) {
        instance.ready = false;
        delete instance.process;
        delete instance.id;
      });

      // When receiving data from R process
      instance.process.stdout.on('data', function (data) {
        var text = new Buffer(data).toString('utf8');

        // If we have a process ready
        if(instance.ready){

          var pattern = '[a-z0-9]{8}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{12}';

          if(instance.job) {
            var log = text.replace(new RegExp('(begin|end|error):' + pattern, 'gi'), '');
            instance.job.log += log;
          }

          if(new RegExp('end:' + pattern).test(text)) {
            var id = text.match(pattern)[0];
            if(id != instance.job.id) console.error('Warning: job id mismatch.')
            instance.job.end = new Date();
            var job = instance.job;
            delete instance.job;
            if(job.callback && typeof(job.callback) == 'function') {
              //console.log(job);
              job.callback(job.err, job.log);
            }
            me.efflux++;
            me.next();
          }

        } else {
          // Else wait for acknowledgment of R process being ready
          var match = text.match('ready:([a-z0-9]{8}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{12})');
          if(match && match[1]){
            var id = match[1];
            instance.ready = true;
            callbackAsync();
          }      
        }
      });

      // Receiving an error
      instance.process.stderr.on('data', function (data) {
        var text = new Buffer(data).toString('utf8');
        if(instance.job) instance.job.err += text;
      });

    }, function(err){
      callback(err);
    });
  };

  // Stop R process
  this.stop = function(){
    for(var i = 0; i < this.instances.length; i++){
      if(this.instances[i].job){
        console.error('Warning: killing process while job is still running...')
      }
      this.instances[i].process.kill();      
    };
  };

  // Execute job ({ id: uuidv4, script: string, callback: function })
  this.execute = function(job){

    if(this.ready() < 1) { console.error('Warning: no R instances to execute script.'); return; }

    this.influx++;

    job.start = new Date();
    job.log   = '';
    job.err   = '';

    var accepted = false;
    for(var i = 0; i < this.instances.length; i++){
      
      if(this.instances[i].job) continue;

      this.instances[i].job = job;

      var _id     = job.id;
      var _script = job.script.replace(/\"/g,'\\\"');
      var exec    = 'tryCatch({ cat("begin:' + _id + '"); eval(parse(text="' + _script + '")); },' +
                    'error   = function(e){ print(e); cat("error:'   + _id + '"); },' + 
                    'finally = { cat("end:' + _id + '"); });';

      this.instances[i].process.stdin.write(exec + '\n');
      accepted = true;
      break;
    }

    if(!accepted) {
      this.queue.push(job);
    }
  };

  // Execute next job in queue
  this.next = function(){
    if(this.queue && this.queue.length){
      var job = this.queue.shift();
      this.execute(job);
    }
  }

  // Run R script with optional callback (simplified interface)
  this.run = function(script, callback){
    if(typeof(script) != 'string' || script == '') { console.error('Warning: no script to run.'); return; }
    if(callback && typeof(callback) != 'function') { console.error('Warning: callback not a function.'); return; }
    if(!this.ready) { console.error('Warning: no instances ready to run script.'); return; }
    this.execute({ id: uuid.v4(), script: script, callback: callback });
  };

  // Run R script on every instance...
  this.init = function(script, callback){

    if(typeof(script) != 'string' || script == '') { console.error('Warning: no script to run.'); return; }
    if(callback && typeof(callback) != 'function') { console.error('Warning: callback not a function.'); return; }
    if(!this.ready) { console.error('Warning: no instances ready to run script.'); return; }

    for(var i = 0; i < this.instances.length; i++){
      if(!this.instances[i].ready) console.error('Warning: instance[' + i + '] not ready.');
      if(this.instances[i].job)    console.error('Warning: instance[' + i + '] is already executing job.');
    }

    async.each(this.instances, function(instance, callbackAsync){

      var callbackWrapper = function(err, job){
        callbackAsync(job.log);
      }

      var job = { id: uuid.v4(), script: script, callback: callbackWrapper };

      job.start = new Date();
      job.log   = '';
      job.err   = '';

      instance.job = job;

      var _id     = job.id;
      var _script = job.script.replace(/\"/g,'\\\"');
      var exec    = 'tryCatch({ cat("begin:' + _id + '"); eval(parse(text="' + _script + '")); },' +
                    'error   = function(e){ print(e); cat("error:'   + _id + '"); },' + 
                    'finally = { cat("end:' + _id + '"); });';

      instance.process.stdin.write(exec + '\n');

    }, function(err){
      if(callback) callback(err);
    });
  }

  this.ready = function(){
    var n = 0;
    for(var i = 0; i < this.instances.length; i++){
      if(this.instances[i].ready) n++;
    };
    return n;
  };

};

exports = module.exports = R;
