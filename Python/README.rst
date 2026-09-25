A3EM Management Dashboard
=========================

Overview
--------

This package is the desktop version of the A3EM Management Dashboard, the tool for setting up
A3EM recorders for a deployment. It is the earlier version of the tool: the A3EM Dashboard website
at `config.a3em.com <https://config.a3em.com>`_ replaces it. The website runs in the browser with
nothing to install, prepares SD cards, and reviews what a recorder brought back. Use it for new
deployments.

The two read and write the same configuration file, ``_conf.a3m``, so a card prepared with either
can be opened in the other, and cards prepared before the file was renamed (``_a3em.cfg``) still
open.

Once this package is installed, the desktop dashboard opens from a terminal with:

``a3em``


Installation
------------

The easiest way to install it is through ``pip``:

``python3 -m pip install a3em``

To install it from the source instead, clone the
`A3EM Dashboard repository <https://github.com/vu-a3em/a3em-dashboard>`_, ``cd`` into its
``Python`` folder, and enter:

``python3 -m pip install -e .``


License
-------

Released under the MIT License.
