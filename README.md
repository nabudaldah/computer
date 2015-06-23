computer
========

Asynchronous computations in R

Off-load your cpu-heavy computations from node to one or multiple independent R child processes in a fully asynchronous manner.

## Setup

Install from npm:

```
npm install computer
```

In your node application:

```
var computer  = require('computer');
var R = new computer('C:/Program Files/R/R-3.2.0/bin/x64/R.exe');

R.start(function(){
  R.run('cat("1 + 2 =", 1 + 2)', function(err, log){
    console.log(log);
    R.stop();
  });
});
```

which wil output:

```
1 + 2 = 3
```

## Hints

Connect R directly to a database to avoid costs of serializing and deserializing data. All major relational and NoSQL databases have drivers for R. In your R script, add something like:

```
library(rmongodb)
mongo <- mongo.create()
```

Utilize al your CPU cores by starting multiple R threads from your node application like so:

```
var binary  = 'C:/Program Files/R/R-3.2.0/bin/x64/R.exe';
var threads = require('os').cpus().length;
var R       = new computer(binary, threads);
```
All scripts given to R will be distributed automatically to all R instances.
